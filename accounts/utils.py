"""
Utils for email sending
"""

import logging
import threading
from pathlib import Path

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string
from django.utils.html import strip_tags

logger = logging.getLogger(__name__)

LOGO_CID = 'kozons_logo'


def _logo_path():
    return Path(settings.BASE_DIR) / 'kozons' / 'static' / 'kozons' / 'logo.png'


def get_email_branding_context():
    return _email_brand_context()


def _email_brand_context():
    has_logo = _logo_path().is_file()
    return {
        'site_name': 'Kozons',
        'site_tagline': 'Discutez, appelez, partagez vos moments.',
        'has_logo': has_logo,
        'logo_src': f'cid:{LOGO_CID}' if has_logo else '',
        'logo_cid': LOGO_CID,
        'color_primary': '#0099cc',
        'color_secondary': '#007aa3',
        'color_green': '#16a34a',
        'color_text': '#3b4a54',
        'color_heading': '#111b21',
        'color_muted': '#667781',
        'color_bg': '#F0F2F5',
        'color_card': '#ffffff',
        'color_accent_bg': '#e6f6fc',
    }


class BrandedEmail(EmailMultiAlternatives):
    """E-mail HTML avec images intégrées (référencées par `cid:` dans le HTML).

    Django 6.1 ne gère plus `mixed_subtype = 'related'` (AttributeError) et déprécie les
    pièces jointes MIMEImage : les images sont donc liées à la partie HTML via l'API
    e-mail moderne de Python, ce qui produit multipart/alternative > multipart/related."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.inline_images = []  # (cid, contenu, sous-type, nom de fichier)

    def attach_inline_image(self, cid, content, subtype='png', filename=None):
        self.inline_images.append((cid, content, subtype, filename or f'{cid}.{subtype}'))

    def message(self, **kwargs):
        msg = super().message(**kwargs)
        if self.inline_images:
            html_part = next((p for p in msg.walk() if p.get_content_type() == 'text/html'), None)
            if html_part is not None:
                for cid, content, subtype, filename in self.inline_images:
                    html_part.add_related(content, 'image', subtype, cid=f'<{cid}>',
                                          filename=filename, disposition='inline')
        return msg


def _attach_logo(email):
    logo_path = _logo_path()
    if not logo_path.is_file():
        return
    email.attach_inline_image(LOGO_CID, logo_path.read_bytes(), 'png', 'logo.png')


def _send_branded_email(*, subject, recipient, template_name, context):
    full_context = {**_email_brand_context(), **context}
    html_body = render_to_string(template_name, full_context)
    text_body = strip_tags(html_body)
    from_email = settings.DEFAULT_FROM_EMAIL

    email = BrandedEmail(
        subject=subject,
        body=text_body,
        from_email=from_email,
        to=[recipient],
    )
    email.attach_alternative(html_body, 'text/html')
    _attach_logo(email)
    email.send(fail_silently=False)


def send_in_background(func, *args, **kwargs):
    """Pour les e-mails non bloquants (confirmation…) : la requête n'attend pas Gmail."""
    if not getattr(settings, 'KOZONS_EMAIL_ASYNC', True):
        return func(*args, **kwargs)
    threading.Thread(target=func, args=args, kwargs=kwargs, daemon=True).start()
    return None


def send_password_reset_otp_email(user, otp):
    try:
        _send_branded_email(
            subject=f'{otp} est votre code de réinitialisation Kozons',
            recipient=user.email,
            template_name='email/password_reset_otp.html',
            context={
                'user': user,
                'otp': otp,
                'expires_in': f'{settings.PASSWORD_RESET_OTP_MINUTES} minutes',
            },
        )
        logger.info("Code de réinitialisation envoyé à l'utilisateur %s", user.pk)
        return True
    except Exception as e:
        logger.error("Erreur envoi email OTP: %s", e, exc_info=True)
        return False


def send_login_otp_email(user, otp, ip=None):
    try:
        _send_branded_email(
            subject=f'{otp} est votre code de connexion Kozons',
            recipient=user.email,
            template_name='email/login_otp.html',
            context={
                'user': user,
                'otp': otp,
                'ip': ip,
                'expires_in': f'{settings.LOGIN_OTP_MINUTES} minutes',
            },
        )
        logger.info("Code de connexion envoyé à l'utilisateur %s", user.pk)
        return True
    except Exception as e:
        logger.error("Erreur envoi email OTP connexion: %s", e, exc_info=True)
        return False


def send_password_changed_email(user):
    try:
        _send_branded_email(
            subject='Votre mot de passe Kozons a été modifié',
            recipient=user.email,
            template_name='email/password_changed.html',
            context={'user': user},
        )
        return True
    except Exception as e:
        logger.error("Erreur envoi email changement de mot de passe: %s", e, exc_info=True)
        return False


def send_email_with_html_body(subject, receivers, template, context):
    if not receivers:
        return False
    try:
        _send_branded_email(
            subject=subject,
            recipient=receivers[0],
            template_name=template,
            context=context,
        )
        return True
    except Exception as e:
        logger.error("Erreur envoi email: %s", e, exc_info=True)
        return False
