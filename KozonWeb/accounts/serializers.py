from chat.models import Participant


def contact_ids(viewer):
    """Ids des utilisateurs partageant au moins une discussion avec `viewer` (mis en cache)."""
    if not getattr(viewer, 'is_authenticated', False):
        return set()
    cached = getattr(viewer, '_contact_ids', None)
    if cached is None:
        conv_ids = Participant.objects.filter(user=viewer).values('conversation_id')
        cached = set(
            Participant.objects.filter(conversation_id__in=conv_ids).values_list('user_id', flat=True)
        )
        viewer._contact_ids = cached
    return cached


def _visible(owner, viewer, setting):
    if viewer is not None and owner.pk == getattr(viewer, 'pk', None):
        return True
    if setting == 'everyone':
        return True
    if setting == 'contacts':
        return owner.pk in contact_ids(viewer)
    return False


def avatar_url(user, viewer=None):
    if not user.avatar:
        return None
    if viewer is not None and not _visible(user, viewer, user.avatar_visibility):
        return None
    return user.avatar.url


def user_brief(user, viewer=None):
    if user is None:
        return None
    data = {
        'id': user.pk,
        'username': user.username,
        'name': user.name,
        'avatar': avatar_url(user, viewer),
        'about': user.about,
        'online': None,
        'last_seen': None,
    }
    if viewer is None or _visible(user, viewer, user.last_seen_visibility):
        data['online'] = user.is_online
        data['last_seen'] = user.last_seen.isoformat() if user.last_seen else None
    return data


def user_private(user):
    """Profil complet de l'utilisateur connecté."""
    data = user_brief(user)
    data.update({
        'email': user.email,
        'bio': user.bio,
        'website': user.website,
        'phone': user.phone,
        'display_name': user.display_name,
        'is_private': user.is_private,
        'last_seen_visibility': user.last_seen_visibility,
        'avatar_visibility': user.avatar_visibility,
        'read_receipts': user.read_receipts,
    })
    return data
