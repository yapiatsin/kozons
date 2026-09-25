import io
import json
import shutil
import tempfile

from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings
from PIL import Image

from accounts.models import User
from chat.models import Message, Sticker, UserSticker

MEDIA = tempfile.mkdtemp()


def png(color='red', size=(300, 200)):
    buf = io.BytesIO()
    Image.new('RGB', size, color).save(buf, 'PNG')
    return SimpleUploadedFile('s.png', buf.getvalue(), content_type='image/png')


def gif():
    frames = [Image.new('RGB', (100, 100), c) for c in ('red', 'green', 'blue')]
    buf = io.BytesIO()
    frames[0].save(buf, 'GIF', save_all=True, append_images=frames[1:], duration=100, loop=0)
    return SimpleUploadedFile('a.gif', buf.getvalue(), content_type='image/gif')


def jpost(c, url, data=None):
    return c.post('/api/' + url, json.dumps(data or {}), content_type='application/json')


@override_settings(MEDIA_ROOT=MEDIA)
class StickerTests(TestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        cache.clear()
        self.alice = User.objects.create_user('alice', password='x')
        self.bob = User.objects.create_user('bob', password='x')
        self.carol = User.objects.create_user('carol', password='x')
        self.ca, self.cb, self.cc = Client(), Client(), Client()
        self.ca.force_login(self.alice); self.cb.force_login(self.bob); self.cc.force_login(self.carol)
        self.conv = jpost(self.ca, 'conversations/direct', {'user_id': self.bob.pk}).json()['id']

    def create(self, client, f):
        r = client.post('/api/stickers', {'file': f})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_create_converts_to_512_webp(self):
        s = self.create(self.ca, png())
        self.assertTrue(s['saved'])
        sticker = Sticker.objects.get(pk=s['id'])
        img = Image.open(sticker.file.path)
        self.assertEqual((img.format, img.size, img.mode), ('WEBP', (512, 512), 'RGBA'))
        self.assertEqual(img.getpixel((0, 0))[3], 0)  # marges transparentes
        self.assertEqual(self.ca.get('/api/stickers').json()['mine'][0]['id'], s['id'])

    def test_animated_gif_stays_animated(self):
        s = self.create(self.ca, gif())
        self.assertTrue(s['animated'])
        img = Image.open(Sticker.objects.get(pk=s['id']).file.path)
        self.assertEqual(img.n_frames, 3)

    def test_invalid_file_rejected(self):
        bad = SimpleUploadedFile('x.png', b'pas une image', content_type='image/png')
        self.assertEqual(self.ca.post('/api/stickers', {'file': bad}).status_code, 400)

    def test_same_image_is_deduplicated(self):
        a = self.create(self.ca, png('blue'))
        b = self.create(self.cb, png('blue'))
        self.assertEqual(a['id'], b['id'])
        self.assertEqual(Sticker.objects.count(), 1)

    def test_send_recent_and_receiver_can_favorite(self):
        s = self.create(self.ca, png())
        r = self.ca.post(f'/api/conversations/{self.conv}/messages', {'kind': 'sticker', 'sticker_id': s['id']})
        self.assertEqual(r.status_code, 200, r.content)
        msg = r.json()
        self.assertEqual((msg['kind'], msg['sticker_id']), ('sticker', s['id']))
        self.assertEqual(self.ca.get('/api/stickers').json()['recent'][0]['id'], s['id'])
        # Bob a reçu le sticker : il peut l'ajouter à ses favoris.
        r = jpost(self.cb, f'messages/{msg["id"]}/sticker', {'action': 'favorite'})
        self.assertTrue(r.json()['favorite'])
        self.assertEqual([x['id'] for x in self.cb.get('/api/stickers').json()['favorites']], [s['id']])
        r = jpost(self.cb, f'stickers/{s["id"]}', {'action': 'toggle_favorite'})
        self.assertFalse(r.json()['favorite'])
        self.assertFalse(UserSticker.objects.filter(user=self.bob).exists())

    def test_outsider_cannot_use_sticker(self):
        s = self.create(self.ca, png())
        self.assertEqual(jpost(self.cc, f'stickers/{s["id"]}', {'action': 'favorite'}).status_code, 404)
        other = jpost(self.cc, 'conversations/direct', {'user_id': self.alice.pk}).json()['id']
        r = self.cc.post(f'/api/conversations/{other}/messages', {'kind': 'sticker', 'sticker_id': s['id']})
        self.assertEqual(r.status_code, 404)

    def test_send_uploaded_image_as_sticker(self):
        r = self.ca.post(f'/api/conversations/{self.conv}/messages', {'kind': 'sticker', 'file': png('green')})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()['file'].endswith('.webp'))

    def test_delete_message_keeps_sticker_file(self):
        s = self.create(self.ca, png())
        mid = self.ca.post(f'/api/conversations/{self.conv}/messages', {'kind': 'sticker', 'sticker_id': s['id']}).json()['id']
        jpost(self.ca, f'messages/{mid}/delete', {'scope': 'everyone'})
        sticker = Sticker.objects.get(pk=s['id'])
        self.assertTrue(sticker.file.storage.exists(sticker.file.name))
        self.assertTrue(Message.objects.get(pk=mid).deleted)

    def test_remove_from_collection(self):
        s = self.create(self.ca, png())
        jpost(self.ca, f'stickers/{s["id"]}', {'action': 'remove'})
        self.assertEqual(self.ca.get('/api/stickers').json()['mine'], [])
