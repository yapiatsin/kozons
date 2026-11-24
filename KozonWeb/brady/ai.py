"""Brady : l'assistant IA de Kozons, spécialiste des idées (propositions, développement, stratégies).

Réponses rédigées par le modèle gratuit configuré (kozons.llm : GPT-OSS 120B via Groq par défaut),
ou par Claude si seule ANTHROPIC_API_KEY est renseignée ; envoyées au fil de l'eau au navigateur.
"""
from django.conf import settings

# Historique transmis à l'IA : les derniers échanges de la conversation suffisent au contexte.
HISTORY_MESSAGES = 30
MAX_INPUT_CHARS = 8000

SYSTEM_PROMPT = """Tu es Brady, l'assistant IA de Kozons, un réseau social (discussions, appels, publications,
lives, réunions). Ta spécialité : les idées. Tu aides chaque utilisateur à :
1. Proposer des idées : projets, business, contenus, événements, cadeaux, solutions à un problème…
   Propose des idées concrètes, variées et adaptées à la situation de la personne, pas des généralités.
2. Développer les idées qu'on te soumet : clarifier l'idée, la cible, la valeur apportée, les forces,
   les risques, les variantes possibles et la première version réaliste à lancer.
3. Montrer comment les développer, avec méthode : étapes ordonnées, stratégie, outils et méthodes
   adaptés (par exemple Lean Canvas, SWOT, MVP, OKR, persona, plan marketing, budget), indicateurs
   de réussite et prochaines actions concrètes.

Façon de répondre :
- Réponds dans la langue de l'utilisateur (le plus souvent le français), sur un ton chaleureux,
  motivant et direct. Tu peux tutoyer si l'utilisateur tutoie.
- Structure tes réponses avec des titres courts (##), des listes et du **gras** pour l'essentiel ;
  reste lisible sur un téléphone : pas de tableaux larges, des paragraphes courts.
- Va à l'essentiel : une réponse utile et actionnable vaut mieux qu'une réponse longue. Pour une
  question simple, réponds simplement.
- Si l'idée manque d'informations importantes (budget, public, pays, délai), fais une proposition
  avec des hypothèses raisonnables et pose une ou deux questions pour affiner.
- Tiens compte du contexte local quand il est donné (pays, ville, moyens de l'utilisateur).
- Termine les réponses de développement par une courte section « Prochaines étapes ».
- Sois honnête sur les risques ; n'invente pas de chiffres précis présentés comme des faits.
- Tu ne donnes pas de conseils médicaux, juridiques ou financiers personnalisés à la place d'un
  professionnel : tu peux aider à préparer les bonnes questions à lui poser.
- Si on te demande qui tu es : tu es Brady, l'assistant des idées de Kozons."""


def enabled():
    from kozons import llm
    return llm.enabled()


def build_messages(history, max_chars=None):
    """Historique (du plus ancien au plus récent) au format de l'API ; commence par un message utilisateur.
    max_chars : on ne garde que les échanges les plus récents qui tiennent dans cette taille
    (le quota gratuit limite le nombre de jetons par minute)."""
    msgs = [{'role': m.role, 'content': m.content} for m in history if m.content.strip()]
    if max_chars:
        kept, total = [], 0
        for m in reversed(msgs):
            if kept and total + len(m['content']) > max_chars:
                break
            kept.append(m)
            total += len(m['content'])
        msgs = kept[::-1]
    while msgs and msgs[0]['role'] != 'user':
        msgs.pop(0)
    return msgs


async def stream_reply(messages):
    """Générateur asynchrone des morceaux de texte de la réponse de Brady."""
    from kozons import llm
    if llm.provider() == 'openai':
        async for text in llm.stream(SYSTEM_PROMPT, messages, max_tokens=3000):
            yield text
        return
    import anthropic
    client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
    # fallbacks="default" : si un filtre de sécurité refuse à tort, l'API relance sur un autre modèle.
    async with client.beta.messages.stream(
        model=settings.BRADY_AI_MODEL,
        max_tokens=8000,
        system=SYSTEM_PROMPT,
        messages=messages,
        output_config={'effort': 'medium'},
        betas=['server-side-fallback-2026-07-01'],
        fallbacks='default',
    ) as stream:
        async for text in stream.text_stream:
            yield text
        final = await stream.get_final_message()
    if final.stop_reason == 'refusal':
        raise RefusalError()


class RefusalError(Exception):
    pass


def error_message(exc):
    from kozons.llm import LLMError
    if isinstance(exc, LLMError):
        return exc.message
    try:
        import anthropic
    except ImportError:
        return "Le module « anthropic » n'est pas installé sur le serveur."
    if isinstance(exc, RefusalError):
        return "Je ne peux pas t'aider sur cette demande. Essaie de la reformuler autrement."
    if isinstance(exc, anthropic.AuthenticationError):
        return "Brady n'est pas correctement configuré (clé API invalide)."
    if isinstance(exc, anthropic.RateLimitError):
        return "Brady reçoit beaucoup de demandes en ce moment. Réessaie dans un instant."
    if isinstance(exc, anthropic.APIConnectionError):
        return "Impossible de joindre Brady pour le moment. Vérifie ta connexion et réessaie."
    if isinstance(exc, anthropic.APIStatusError):
        return f"Brady a rencontré un problème ({exc.status_code}). Réessaie dans un instant."
    return "Brady a rencontré un problème inattendu. Réessaie dans un instant."
