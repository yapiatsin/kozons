import json
import logging

from asgiref.sync import sync_to_async
from django.conf import settings
from django.http import JsonResponse, StreamingHttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.http import require_POST

from kozons.api import ApiError, api, as_int, rate_limit

from . import ai
from .models import Message, Thread

logger = logging.getLogger(__name__)


def thread_data(t):
    return {'id': t.pk, 'title': t.title or 'Nouvelle conversation', 'updated_at': t.updated_at.isoformat()}


def message_data(m):
    return {'id': m.pk, 'role': m.role, 'content': m.content, 'created_at': m.created_at.isoformat()}


@api(['GET'])
def threads(request):
    qs = Thread.objects.filter(user=request.user)[:100]
    return {'results': [thread_data(t) for t in qs], 'enabled': ai.enabled()}


@api(['GET'])
def thread_detail(request, pk):
    t = get_object_or_404(Thread, pk=pk, user=request.user)
    return {'thread': thread_data(t), 'messages': [message_data(m) for m in t.messages.all()]}


@api(['POST'])
def thread_delete(request, pk):
    get_object_or_404(Thread, pk=pk, user=request.user).delete()
    return {'ok': True}


@api(['POST'])
def threads_clear(request):
    Thread.objects.filter(user=request.user).delete()
    return {'ok': True}


# ---------------------------------------------------------------- réponse de Brady (au fil de l'eau)

def _start_turn(request, data):
    """Vérifications + enregistrement du message de l'utilisateur. Renvoie (fil, historique)."""
    rate_limit(request, 'brady', 40, 3600)
    text = (data.get('text') or '').strip()
    if not text:
        raise ApiError('Écris ton message à Brady.')
    if len(text) > ai.MAX_INPUT_CHARS:
        raise ApiError(f'Message trop long ({ai.MAX_INPUT_CHARS} caractères maximum).')
    thread_id = as_int(data.get('thread_id'))
    if thread_id:
        thread = Thread.objects.filter(pk=thread_id, user=request.user).first()
        if thread is None:
            raise ApiError('Conversation introuvable.', 404)
    else:
        title = ' '.join(text.split())
        thread = Thread.objects.create(user=request.user, title=title[:80] + ('…' if len(title) > 80 else ''))
    Message.objects.create(thread=thread, role=Message.USER, content=text)
    history = list(thread.messages.order_by('-created_at', '-id')[:ai.HISTORY_MESSAGES])[::-1]
    return thread, ai.build_messages(history, max_chars=settings.AI_MAX_INPUT_CHARS)


def _save_reply(thread, text):
    Message.objects.create(thread=thread, role=Message.ASSISTANT, content=text)
    Thread.objects.filter(pk=thread.pk).update(updated_at=timezone.now())


def _event(kind, **data):
    return (json.dumps({'type': kind, **data}, ensure_ascii=False) + '\n').encode()


@require_POST
async def chat(request):
    """POST {text, thread_id?} -> flux NDJSON : meta (fil), delta (texte), done ou error."""
    user = await request.auser()
    if not user.is_authenticated:
        return JsonResponse({'error': 'Non authentifié'}, status=401)
    try:
        data = json.loads(request.body or b'{}')
    except json.JSONDecodeError:
        return JsonResponse({'error': 'JSON invalide'}, status=400)
    if not ai.enabled():
        return JsonResponse({'error': "Brady n'est pas encore disponible sur ce serveur (IA non configurée)."}, status=503)
    try:
        thread, messages = await sync_to_async(_start_turn)(request, data)
    except ApiError as e:
        return JsonResponse({'error': e.message}, status=e.status)

    async def events():
        yield _event('meta', thread=thread_data(thread))
        parts = []
        try:
            async for chunk in ai.stream_reply(messages):
                parts.append(chunk)
                yield _event('delta', text=chunk)
        except Exception as exc:  # erreur réseau, quota, refus… : message clair, rien d'enregistré à moitié
            logger.exception('Brady : échec de la réponse (fil %s)', thread.pk)
            if parts:
                await sync_to_async(_save_reply)(thread, ''.join(parts))
            yield _event('error', message=ai.error_message(exc))
            return
        await sync_to_async(_save_reply)(thread, ''.join(parts))
        yield _event('done')

    response = StreamingHttpResponse(events(), content_type='application/x-ndjson; charset=utf-8')
    response['Cache-Control'] = 'no-cache'
    response['X-Accel-Buffering'] = 'no'  # pas de mise en tampon par un proxy : le texte s'affiche au fur et à mesure
    return response
