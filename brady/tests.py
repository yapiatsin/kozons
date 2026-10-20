import json
from unittest import mock

from asgiref.sync import sync_to_async
from django.core.cache import cache
from django.test import AsyncClient, Client, TransactionTestCase, override_settings

from accounts.models import User

from . import ai
from .models import Message, Thread


def fake_stream(*chunks, fail=None):
    async def gen(messages):
        gen.messages = messages
        for c in chunks:
            yield c
        if fail:
            raise fail
    return gen


async def read_events(response):
    raw = b''
    async for part in response.streaming_content:
        raw += part
    return [json.loads(line) for line in raw.decode().splitlines() if line.strip()]


@override_settings(ANTHROPIC_API_KEY='sk-test', AI_API_KEY='')
class BradyTests(TransactionTestCase):
    async def asyncSetUp(self):
        await sync_to_async(cache.clear)()
        self.user = await sync_to_async(User.objects.create_user)('awa', password='x')
        self.client = AsyncClient()
        await self.client.aforce_login(self.user)

    async def post(self, data):
        return await self.client.post('/api/brady/chat', json.dumps(data), content_type='application/json')

    async def test_streams_reply_and_saves_conversation(self):
        await self.asyncSetUp()
        with mock.patch.object(ai, 'stream_reply', fake_stream('## Idées\n', '- Une boutique ', 'en ligne')):
            r = await self.post({'text': "Propose-moi des idées de business à Abidjan avec 100 000 F"})
            events = await read_events(r)
        self.assertEqual([e['type'] for e in events], ['meta', 'delta', 'delta', 'delta', 'done'])
        thread_id = events[0]['thread']['id']
        self.assertTrue(events[0]['thread']['title'].startswith('Propose-moi des idées'))
        msgs = await sync_to_async(lambda: list(Message.objects.filter(thread_id=thread_id).values_list('role', 'content')))()
        self.assertEqual(msgs, [('user', "Propose-moi des idées de business à Abidjan avec 100 000 F"),
                                ('assistant', '## Idées\n- Une boutique en ligne')])
        # Suite de la conversation : l'historique est transmis à l'IA.
        stream = fake_stream('Voici comment la développer…')
        with mock.patch.object(ai, 'stream_reply', stream):
            await read_events(await self.post({'text': 'Développe la boutique en ligne', 'thread_id': thread_id}))
        self.assertEqual([m['role'] for m in stream.messages], ['user', 'assistant', 'user'])
        self.assertEqual(stream.messages[-1]['content'], 'Développe la boutique en ligne')

    async def test_error_is_reported_and_partial_reply_kept(self):
        await self.asyncSetUp()
        with mock.patch.object(ai, 'stream_reply', fake_stream('Début ', fail=ConnectionError('coupure'))), \
                self.assertLogs('brady.views', level='ERROR'):
            events = await read_events(await self.post({'text': 'Une idée ?'}))
        self.assertEqual(events[-1]['type'], 'error')
        self.assertIn('problème', events[-1]['message'])
        self.assertEqual(await sync_to_async(Message.objects.filter(role='assistant').count)(), 1)

    async def test_validation(self):
        await self.asyncSetUp()
        self.assertEqual((await self.post({'text': '   '})).status_code, 400)
        self.assertEqual((await self.post({'text': 'x' * (ai.MAX_INPUT_CHARS + 1)})).status_code, 400)
        self.assertEqual((await self.post({'text': 'salut', 'thread_id': 999})).status_code, 404)
        self.assertEqual((await AsyncClient().post('/api/brady/chat', '{}', content_type='application/json')).status_code, 401)
        with override_settings(ANTHROPIC_API_KEY='', AI_API_KEY=''):
            self.assertEqual((await self.post({'text': 'salut'})).status_code, 503)


class BradyThreadsTests(TransactionTestCase):
    def test_threads_are_private(self):
        awa = User.objects.create_user('awa', password='x')
        koffi = User.objects.create_user('koffi', password='x')
        t = Thread.objects.create(user=awa, title='Idée de podcast')
        Message.objects.create(thread=t, role='user', content='Une idée de podcast ?')
        ca, ck = Client(), Client()
        ca.force_login(awa)
        ck.force_login(koffi)
        self.assertEqual([x['title'] for x in ca.get('/api/brady/threads').json()['results']], ['Idée de podcast'])
        self.assertEqual(ck.get('/api/brady/threads').json()['results'], [])
        self.assertEqual(ck.get(f'/api/brady/threads/{t.pk}').status_code, 404)
        self.assertEqual(len(ca.get(f'/api/brady/threads/{t.pk}').json()['messages']), 1)
        self.assertEqual(ck.post(f'/api/brady/threads/{t.pk}/delete').status_code, 404)
        ca.post(f'/api/brady/threads/{t.pk}/delete')
        self.assertFalse(Thread.objects.exists())

    def test_history_starts_with_user(self):
        t = Thread.objects.create(user=User.objects.create_user('a', password='x'))
        msgs = [Message(thread=t, role='assistant', content='…'), Message(thread=t, role='user', content='Salut')]
        self.assertEqual(ai.build_messages(msgs), [{'role': 'user', 'content': 'Salut'}])
