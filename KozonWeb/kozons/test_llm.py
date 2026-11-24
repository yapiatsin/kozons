import json
from unittest import mock

import httpx
from asgiref.sync import async_to_sync
from django.test import SimpleTestCase, TestCase, override_settings

from kozons import llm

FREE = dict(AI_API_KEY='gsk-test', AI_API_BASE='https://api.groq.com/openai/v1', AI_MODEL='openai/gpt-oss-120b',
            AI_REASONING_EFFORT='low', AI_MAX_INPUT_CHARS=12000, ANTHROPIC_API_KEY='')


def transport(handler):
    """Remplace les clients httpx de kozons.llm par un faux service (aucun appel réseau)."""
    real_client, real_async = httpx.Client, httpx.AsyncClient
    mt = httpx.MockTransport(handler)
    return mock.patch.multiple(llm.httpx,
                               Client=lambda **kw: real_client(transport=mt, **kw),
                               AsyncClient=lambda **kw: real_async(transport=mt, **kw))


@override_settings(**FREE)
class FreeModelTests(SimpleTestCase):
    def test_provider_choice(self):
        self.assertEqual(llm.provider(), 'openai')
        with override_settings(AI_API_KEY='', ANTHROPIC_API_KEY='sk-ant'):
            self.assertEqual(llm.provider(), 'anthropic')
        with override_settings(AI_API_KEY=''):
            self.assertFalse(llm.enabled())

    def test_complete_json_and_request_shape(self):
        seen = {}

        def handler(request):
            seen['url'] = str(request.url)
            seen['auth'] = request.headers['authorization']
            seen['body'] = json.loads(request.content)
            return httpx.Response(200, json={'choices': [{'finish_reason': 'stop', 'message': {'content': '{"title": "Point"}'}}]})

        with transport(handler):
            data = llm.complete_json('Système', [{'role': 'user', 'content': 'Bonjour'}])
        self.assertEqual(data, {'title': 'Point'})
        self.assertEqual(seen['url'], 'https://api.groq.com/openai/v1/chat/completions')
        self.assertEqual(seen['auth'], 'Bearer gsk-test')
        body = seen['body']
        self.assertEqual((body['model'], body['reasoning_effort'], body['response_format']), ('openai/gpt-oss-120b', 'low', {'type': 'json_object'}))
        self.assertEqual(body['messages'][0], {'role': 'system', 'content': 'Système'})

    def test_quota_waits_then_retries(self):
        calls = []

        def handler(request):
            calls.append(1)
            if len(calls) == 1:
                return httpx.Response(429, headers={'retry-after': '2'}, json={'error': {'message': 'rate limit'}})
            return httpx.Response(200, json={'choices': [{'finish_reason': 'stop', 'message': {'content': 'ok'}}]})

        with transport(handler), mock.patch.object(llm.time, 'sleep') as sleep:
            self.assertEqual(llm.complete('s', [{'role': 'user', 'content': 'x'}]), 'ok')
        self.assertEqual(len(calls), 2)
        sleep.assert_called_once()

    def test_errors_are_readable(self):
        with transport(lambda r: httpx.Response(401, json={})):
            with self.assertRaises(llm.LLMError) as ctx:
                llm.complete('s', [{'role': 'user', 'content': 'x'}])
        self.assertIn('AI_API_KEY', ctx.exception.message)

    def test_stream(self):
        events = [{'choices': [{'delta': {'role': 'assistant'}}]}, {'choices': [{'delta': {'content': 'Voici '}}]},
                  {'choices': [{'delta': {'content': '3 idées'}}]}]
        sse = ''.join(f'data: {json.dumps(e)}\n\n' for e in events) + 'data: [DONE]\n\n'

        def handler(request):
            assert json.loads(request.content)['stream'] is True
            return httpx.Response(200, content=sse.encode(), headers={'content-type': 'text/event-stream'})

        async def collect():
            return [t async for t in llm.stream('s', [{'role': 'user', 'content': 'x'}])]

        with transport(handler):
            self.assertEqual(async_to_sync(collect)(), ['Voici ', '3 idées'])

        with transport(lambda r: httpx.Response(429, json={})):
            with self.assertRaises(llm.LLMError) as ctx:
                async_to_sync(collect)()
        self.assertIn('quota', ctx.exception.message)


@override_settings(**FREE)
class FreeMeetNotesTests(TestCase):
    def test_long_meeting_is_summarized_by_parts(self):
        from meet import ai
        document = '\n'.join(f'[{i:02d}:00] Awa : point numéro {i} ' + 'détail ' * 60 for i in range(80))
        partial = mock.Mock(side_effect=lambda *a, **k: 'notes de la partie')
        final = {'title': 'Bilan', 'summary': 'Résumé', 'decisions': ['Lancer vendredi'], 'action_items': [{'task': 'Maquette', 'owner': 'Koffi'}]}
        with mock.patch('kozons.llm.complete', partial), mock.patch('kozons.llm.complete_json', return_value=final) as merge:
            summary, model = ai._summarize_free(document)
        self.assertGreater(partial.call_count, 1)                    # une requête par partie
        self.assertIn('Partie 1 sur', merge.call_args.args[1][0]['content'])
        self.assertEqual(model, 'openai/gpt-oss-120b')
        # Clés manquantes complétées, types garantis.
        self.assertEqual(summary['key_points'], [])
        self.assertEqual(summary['action_items'], [{'task': 'Maquette', 'owner': 'Koffi', 'due': ''}])

    def test_short_meeting_single_request(self):
        from meet import ai
        with mock.patch('kozons.llm.complete') as partial, \
                mock.patch('kozons.llm.complete_json', return_value={'title': 'Court'}) as one:
            summary, _ = ai._summarize_free('[00:01] Awa : bonjour')
        partial.assert_not_called()
        one.assert_called_once()
        self.assertEqual(summary['title'], 'Court')


class BradyHistoryTests(SimpleTestCase):
    def test_history_capped_to_recent_messages(self):
        from brady import ai
        msgs = [mock.Mock(role=r, content=c) for r, c in
                [('user', 'a' * 50), ('assistant', 'b' * 50), ('user', 'c' * 50), ('assistant', 'd' * 50), ('user', 'dernier')]]
        kept = ai.build_messages(msgs, max_chars=120)
        self.assertEqual([m['content'][:1] for m in kept], ['c', 'd', 'd'])  # les plus récents, à partir d'un message utilisateur
        self.assertEqual(kept[0]['role'], 'user')
        self.assertEqual(kept[-1]['content'], 'dernier')
        self.assertLessEqual(sum(len(m['content']) for m in kept), 120)
