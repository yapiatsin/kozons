"""Accès au modèle d'IA de Kozons (Brady, notes de réunion Meet).

Par défaut : un modèle gratuit via une API « compatible OpenAI » — Groq (GPT-OSS 120B) dans la
configuration fournie. Changer de fournisseur gratuit (Gemini, OpenRouter, Mistral…) ne demande que
AI_API_BASE, AI_MODEL et AI_API_KEY dans le .env. Sans AI_API_KEY mais avec ANTHROPIC_API_KEY,
Kozons utilise Claude (payant) comme auparavant.
"""
import json
import logging
import time

import httpx
from django.conf import settings

logger = logging.getLogger(__name__)

TIMEOUT = httpx.Timeout(120.0, connect=10.0)


class LLMError(Exception):
    """Erreur du service d'IA, avec un message lisible par l'utilisateur."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.message = message
        self.status = status


def provider():
    if settings.AI_API_KEY:
        return 'openai'
    if settings.ANTHROPIC_API_KEY:
        return 'anthropic'
    return None


def enabled():
    return provider() is not None


def _headers():
    return {'Authorization': f'Bearer {settings.AI_API_KEY}', 'Content-Type': 'application/json'}


def _payload(system, messages, max_tokens, model=None, stream=False, json_mode=False):
    body = {
        'model': model or settings.AI_MODEL,
        'messages': [{'role': 'system', 'content': system}, *messages],
        'max_tokens': max_tokens,
        'temperature': 0.7 if not json_mode else 0.3,
        'stream': stream,
    }
    # Modèles « raisonnants » (GPT-OSS…) : profondeur de réflexion ; le raisonnement reste hors de la réponse.
    if settings.AI_REASONING_EFFORT and 'gpt-oss' in body['model']:
        body['reasoning_effort'] = settings.AI_REASONING_EFFORT
    if json_mode:
        body['response_format'] = {'type': 'json_object'}
    return body


def _http_error(status, text):
    if status == 401:
        return LLMError("Clé d'API de l'IA invalide (AI_API_KEY).", status)
    if status == 429:
        return LLMError("L'IA reçoit trop de demandes en ce moment (quota gratuit atteint). Réessaie dans un instant.", status)
    if status == 413:
        return LLMError('Texte trop long pour le modèle gratuit.', status)
    logger.warning('IA : réponse %s : %s', status, text[:500])
    return LLMError(f"Le service d'IA a rencontré un problème ({status}). Réessaie dans un instant.", status)


# ---------------------------------------------------------------- réponse complète (comptes rendus)

def complete(system, messages, *, max_tokens=8000, json_mode=False, model=None, retries=4):
    """Réponse complète (synchrone, tâches de fond). json_mode : la réponse est un objet JSON.
    Quota gratuit dépassé (429) : on attend le délai indiqué par le service, puis on réessaie."""
    if provider() != 'openai':
        raise LLMError("Aucun modèle d'IA gratuit n'est configuré (AI_API_KEY).")
    body = _payload(system, messages, max_tokens, model=model, json_mode=json_mode)
    for attempt in range(retries + 1):
        try:
            with httpx.Client(timeout=TIMEOUT) as client:
                r = client.post(f'{settings.AI_API_BASE}/chat/completions', headers=_headers(), json=body)
        except httpx.HTTPError as exc:
            if attempt < retries:
                time.sleep(5 * (attempt + 1))
                continue
            raise LLMError("Impossible de joindre le service d'IA.") from exc
        if r.status_code in (429, 500, 502, 503) and attempt < retries:
            try:
                wait = float(r.headers.get('retry-after') or 0)
            except ValueError:
                wait = 0
            time.sleep(min(max(wait, 10 * (attempt + 1)), 65))
            continue
        break
    if r.status_code >= 400:
        raise _http_error(r.status_code, r.text)
    choice = r.json()['choices'][0]
    if choice.get('finish_reason') == 'length':
        raise LLMError('Réponse interrompue (trop longue).')
    return (choice.get('message') or {}).get('content') or ''


def complete_json(system, messages, **kw):
    text = complete(system, messages, json_mode=True, **kw).strip()
    if text.startswith('```'):
        text = text.strip('`').split('\n', 1)[-1].rsplit('```', 1)[0]
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise LLMError("L'IA a renvoyé un compte rendu illisible. Réessaie.") from exc


# ---------------------------------------------------------------- réponse au fil de l'eau (Brady)

async def stream(system, messages, *, max_tokens=4000, model=None):
    """Générateur asynchrone des morceaux de texte de la réponse."""
    if provider() != 'openai':
        raise LLMError("Aucun modèle d'IA gratuit n'est configuré (AI_API_KEY).")
    body = _payload(system, messages, max_tokens, model=model, stream=True)
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            async with client.stream('POST', f'{settings.AI_API_BASE}/chat/completions', headers=_headers(), json=body) as r:
                if r.status_code >= 400:
                    raise _http_error(r.status_code, (await r.aread()).decode(errors='replace'))
                async for line in r.aiter_lines():
                    if not line.startswith('data:'):
                        continue
                    data = line[5:].strip()
                    if data == '[DONE]':
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if chunk.get('error'):
                        raise LLMError("Le service d'IA a interrompu la réponse. Réessaie.")
                    for choice in chunk.get('choices') or []:
                        text = (choice.get('delta') or {}).get('content')
                        if text:
                            yield text
    except httpx.HTTPError as exc:
        raise LLMError("Impossible de joindre le service d'IA. Vérifie ta connexion et réessaie.") from exc
