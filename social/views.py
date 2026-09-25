import re

from django.db import transaction
from django.db.models import Count, Exists, OuterRef, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone

from accounts.models import Block, User
from accounts.serializers import contact_ids, user_brief
from chat.realtime import push
from kozons.api import ApiError, api, as_bool, as_int, body, media_kind, rate_limit

from .models import (CloseFriend, Comment, CommentLike, Follow, Like, Notification, Post, PostMedia,
                     SavedPost, Story, StoryView)

MENTION_RE = re.compile(r'@([a-zA-Z0-9._]{3,30})')
PAGE = 12


# ---------------------------------------------------------------- Accès

def is_following(viewer, owner):
    return Follow.objects.filter(follower=viewer, following=owner, accepted=True).exists()


def can_view_content(viewer, owner):
    if viewer.pk == owner.pk:
        return True
    if Block.between(viewer, owner):
        return False
    return not owner.is_private or is_following(viewer, owner)


def can_view_post(viewer, post):
    return can_view_content(viewer, post.author) and (not post.archived or post.author_id == viewer.pk)


def blocked_ids(user):
    """Utilisateurs bloqués par `user` ou l'ayant bloqué."""
    rows = Block.objects.filter(Q(blocker=user) | Q(blocked=user)).values_list('blocker_id', 'blocked_id')
    ids = {i for pair in rows for i in pair}
    ids.discard(user.pk)
    return ids


def visible_authors_q(viewer):
    """Filtre : auteurs publics, suivis, ou soi-même ; jamais les comptes bloqués."""
    followed = Follow.objects.filter(follower=viewer, accepted=True).values('following_id')
    return (Q(author__is_private=False) | Q(author_id__in=followed) | Q(author=viewer)) & ~Q(author_id__in=blocked_ids(viewer))


def notify(recipient, actor, verb, post=None, comment=None):
    if recipient.pk == actor.pk:
        return
    n = Notification.objects.create(recipient=recipient, actor=actor, verb=verb, post=post, comment=comment)
    push([recipient.pk], 'notification', notification_data(n, recipient))


def notify_mentions(text, actor, post, comment=None):
    names = {m.lower() for m in MENTION_RE.findall(text or '')}
    for user in User.objects.filter(username__in=names).exclude(pk=actor.pk)[:20]:
        notify(user, actor, 'mention', post=post, comment=comment)


# ---------------------------------------------------------------- Sérialisation

def post_queryset(viewer):
    return (Post.objects.select_related('author').prefetch_related('media')
            .annotate(like_count=Count('likes', distinct=True), comment_count=Count('comments', distinct=True),
                      liked=Exists(Like.objects.filter(post=OuterRef('pk'), user=viewer)),
                      saved=Exists(SavedPost.objects.filter(post=OuterRef('pk'), user=viewer))))


def post_data(post, viewer):
    own = post.author_id == viewer.pk
    return {
        'id': post.pk,
        'author': user_brief(post.author, viewer),
        'caption': post.caption,
        'location': post.location,
        'is_reel': post.is_reel,
        'media': [{'url': m.file.url, 'kind': m.kind} for m in post.media.all()],
        'created_at': post.created_at.isoformat(),
        'like_count': post.like_count if (own or not post.hide_likes) else None,
        'comment_count': post.comment_count,
        'liked': post.liked,
        'saved': post.saved,
        'comments_disabled': post.comments_disabled,
        'hide_likes': post.hide_likes,
        'archived': post.archived,
        'own': own,
    }


def comment_data(c, viewer):
    return {
        'id': c.pk,
        'post_id': c.post_id,
        'user': user_brief(c.user, viewer),
        'text': c.text,
        'parent_id': c.parent_id,
        'created_at': c.created_at.isoformat(),
        'like_count': getattr(c, 'like_count', 0),
        'liked': getattr(c, 'liked', False),
        'reply_count': getattr(c, 'reply_count', 0),
    }


def story_data(s, viewer):
    data = {
        'id': s.pk,
        'user_id': s.user_id,
        'kind': s.kind,
        'file': s.file.url if s.file else None,
        'text': s.text,
        'background': s.background,
        'close_friends_only': s.close_friends_only,
        'created_at': s.created_at.isoformat(),
        'expires_at': s.expires_at.isoformat(),
        'seen': getattr(s, 'seen', False),
        'liked': getattr(s, 'liked_by_me', False),
    }
    if s.user_id == viewer.pk:
        data['view_count'] = getattr(s, 'view_count', 0)
    return data


def notification_data(n, viewer):
    first = n.post.media.first() if n.post_id else None
    return {
        'id': n.pk,
        'actor': user_brief(n.actor, viewer),
        'verb': n.verb,
        'post_id': n.post_id,
        'post_thumb': first.file.url if first and first.kind == 'image' else None,
        'comment': n.comment.text[:120] if n.comment_id else None,
        'read': n.read,
        'created_at': n.created_at.isoformat(),
    }


def profile_data(user, viewer):
    followers = Follow.objects.filter(following=user, accepted=True).count()
    following = Follow.objects.filter(follower=user, accepted=True).count()
    rel = Follow.objects.filter(follower=viewer, following=user).first()
    data = user_brief(user, viewer)
    data.update({
        'bio': user.bio,
        'website': user.website,
        'is_private': user.is_private,
        'post_count': Post.objects.filter(author=user, archived=False).count(),
        'followers': followers,
        'following': following,
        'follow_status': None if rel is None else ('following' if rel.accepted else 'requested'),
        'follows_you': Follow.objects.filter(follower=user, following=viewer, accepted=True).exists(),
        'is_me': user.pk == viewer.pk,
        'blocked': Block.objects.filter(blocker=viewer, blocked=user).exists(),
        'can_view': can_view_content(viewer, user),
        'is_close_friend': CloseFriend.objects.filter(owner=viewer, friend=user).exists(),
        'has_story': Story.objects.filter(user=user, expires_at__gt=timezone.now()).exists(),
    })
    return data


# ---------------------------------------------------------------- Profils & abonnements

@api(['GET'])
def profile(request, username):
    user = get_object_or_404(User, username__iexact=username, is_active=True)
    if Block.objects.filter(blocker=user, blocked=request.user).exists():
        raise ApiError('Utilisateur introuvable.', 404)
    return profile_data(user, request.user)


@api(['GET'])
def profile_posts(request, username):
    user = get_object_or_404(User, username__iexact=username)
    if not can_view_content(request.user, user):
        return {'results': [], 'has_more': False}
    tab = request.GET.get('tab', 'posts')
    qs = post_queryset(request.user).filter(author=user)
    if tab == 'reels':
        qs = qs.filter(is_reel=True, archived=False)
    elif tab == 'archived':
        if user != request.user:
            raise ApiError('Accès refusé.', 403)
        qs = qs.filter(archived=True)
    elif tab == 'saved':
        if user != request.user:
            raise ApiError('Accès refusé.', 403)
        qs = post_queryset(request.user).filter(saves__user=user).filter(visible_authors_q(request.user))
    elif tab == 'tagged':
        qs = post_queryset(request.user).filter(caption__icontains='@' + user.username).filter(visible_authors_q(request.user), archived=False)
    else:
        qs = qs.filter(archived=False)
    return _paginate(request, qs)


def _paginate(request, qs):
    before = as_int(request.GET.get('before'))
    if before:
        qs = qs.filter(pk__lt=before)
    items = list(qs.order_by('-pk')[:PAGE + 1])
    return {'results': [post_data(p, request.user) for p in items[:PAGE]], 'has_more': len(items) > PAGE}


@api(['POST'])
def toggle_follow(request, user_id):
    target = get_object_or_404(User, pk=user_id, is_active=True)
    if target == request.user:
        raise ApiError('Impossible de vous abonner à vous-même.')
    if Block.between(request.user, target):
        raise ApiError('Action impossible.', 403)
    existing = Follow.objects.filter(follower=request.user, following=target).first()
    if existing:
        existing.delete()
        Notification.objects.filter(recipient=target, actor=request.user, verb__in=('follow', 'follow_request')).delete()
        return {'follow_status': None}
    rate_limit(request, 'follow', 200, 3600)
    accepted = not target.is_private
    Follow.objects.create(follower=request.user, following=target, accepted=accepted)
    notify(target, request.user, 'follow' if accepted else 'follow_request')
    return {'follow_status': 'following' if accepted else 'requested'}


@api(['POST'])
def follow_request(request, user_id):
    follow = get_object_or_404(Follow, follower_id=user_id, following=request.user, accepted=False)
    action = body(request).get('action')
    Notification.objects.filter(recipient=request.user, actor_id=user_id, verb='follow_request').delete()
    if action == 'accept':
        follow.accepted = True
        follow.save(update_fields=['accepted'])
        notify(follow.follower, request.user, 'follow_accept')
    else:
        follow.delete()
    return {'ok': True}


@api(['GET'])
def follow_requests(request):
    reqs = Follow.objects.filter(following=request.user, accepted=False).select_related('follower')
    return {'results': [user_brief(f.follower, request.user) for f in reqs]}


@api(['POST'])
def remove_follower(request, user_id):
    Follow.objects.filter(follower_id=user_id, following=request.user).delete()
    return {'ok': True}


@api(['GET'])
def follow_list(request, username, which):
    user = get_object_or_404(User, username__iexact=username)
    if not can_view_content(request.user, user):
        raise ApiError('Ce compte est privé.', 403)
    if which == 'followers':
        rows = Follow.objects.filter(following=user, accepted=True).select_related('follower')
        users = [f.follower for f in rows]
    else:
        rows = Follow.objects.filter(follower=user, accepted=True).select_related('following')
        users = [f.following for f in rows]
    mine = set(Follow.objects.filter(follower=request.user).values_list('following_id', flat=True))
    return {'results': [dict(user_brief(u, request.user), followed=u.pk in mine) for u in users[:500]]}


@api(['POST'])
def toggle_close_friend(request, user_id):
    friend = get_object_or_404(User, pk=user_id)
    obj, created = CloseFriend.objects.get_or_create(owner=request.user, friend=friend)
    if not created:
        obj.delete()
    return {'close_friend': created}


@api(['GET'])
def suggestions(request):
    """Suggestions : amis d'amis puis comptes populaires."""
    mine = Follow.objects.filter(follower=request.user).values('following_id')
    excluded = set(Follow.objects.filter(follower=request.user).values_list('following_id', flat=True)) | blocked_ids(request.user) | {request.user.pk}
    fof = (User.objects.filter(followers_set__follower_id__in=mine, followers_set__accepted=True)
           .exclude(pk__in=excluded).annotate(n=Count('pk')).order_by('-n')[:15])
    users = list(fof)
    if len(users) < 15:
        popular = (User.objects.exclude(pk__in=excluded | {u.pk for u in users}).filter(is_active=True)
                   .annotate(n=Count('followers_set')).order_by('-n', '-date_joined')[:15 - len(users)])
        users += list(popular)
    return {'results': [user_brief(u, request.user) for u in users]}


# ---------------------------------------------------------------- Publications

@api(['GET'])
def feed(request):
    followed = Follow.objects.filter(follower=request.user, accepted=True).values('following_id')
    qs = post_queryset(request.user).filter(Q(author_id__in=followed) | Q(author=request.user), archived=False)
    return _paginate(request, qs)


@api(['GET'])
def explore(request):
    q = (request.GET.get('q') or '').strip()
    qs = post_queryset(request.user).filter(visible_authors_q(request.user), archived=False)
    if q:
        qs = qs.filter(Q(caption__icontains=q) | Q(location__icontains=q) | Q(author__username__icontains=q.lstrip('@')))
    else:
        qs = qs.exclude(author=request.user)
    return _paginate(request, qs)


@api(['GET'])
def reels(request):
    qs = post_queryset(request.user).filter(visible_authors_q(request.user), archived=False, is_reel=True)
    return _paginate(request, qs)


@api(['POST'])
def create_post(request):
    rate_limit(request, 'post', 30, 3600)
    files = request.FILES.getlist('files')
    if not files:
        raise ApiError('Ajoutez au moins une photo ou une vidéo.')
    if len(files) > 10:
        raise ApiError('10 médias maximum par publication.')
    kinds = [media_kind(f) for f in files]
    if any(k not in ('image', 'video') for k in kinds):
        raise ApiError('Seules les photos et vidéos sont acceptées.')
    data = request.POST
    is_reel = as_bool(data.get('is_reel'))
    if is_reel and (len(files) != 1 or kinds[0] != 'video'):
        raise ApiError('Un reel doit contenir exactement une vidéo.')
    with transaction.atomic():
        post = Post.objects.create(author=request.user, caption=(data.get('caption') or '')[:2200],
                                   location=(data.get('location') or '')[:100], is_reel=is_reel,
                                   comments_disabled=as_bool(data.get('comments_disabled')),
                                   hide_likes=as_bool(data.get('hide_likes')))
        PostMedia.objects.bulk_create([PostMedia(post=post, file=f, kind=k, order=i)
                                       for i, (f, k) in enumerate(zip(files, kinds))])
        notify_mentions(post.caption, request.user, post)
    return post_data(post_queryset(request.user).get(pk=post.pk), request.user)


def _visible_post(request, pk):
    post = get_object_or_404(Post.objects.select_related('author'), pk=pk)
    if not can_view_post(request.user, post):
        raise ApiError('Publication introuvable.', 404)
    return post


@api(['GET', 'POST', 'DELETE'])
def post_detail(request, pk):
    post = _visible_post(request, pk)
    if request.method == 'GET':
        return post_data(post_queryset(request.user).get(pk=pk), request.user)
    if post.author_id != request.user.pk:
        raise ApiError('Accès refusé.', 403)
    if request.method == 'DELETE':
        for m in post.media.all():
            m.file.delete(save=False)
        post.delete()
        return {'ok': True}
    data = body(request)
    if 'caption' in data:
        post.caption = (data.get('caption') or '')[:2200]
    for field in ('comments_disabled', 'hide_likes', 'archived'):
        if field in data:
            setattr(post, field, as_bool(data.get(field)))
    post.save()
    return post_data(post_queryset(request.user).get(pk=pk), request.user)


@api(['POST'])
def like_post(request, pk):
    post = _visible_post(request, pk)
    like = Like.objects.filter(post=post, user=request.user).first()
    if like:
        like.delete()
    else:
        Like.objects.get_or_create(post=post, user=request.user)
        notify(post.author, request.user, 'like', post=post)
    return {'liked': like is None, 'like_count': post.likes.count()}


@api(['POST'])
def save_post(request, pk):
    post = _visible_post(request, pk)
    obj, created = SavedPost.objects.get_or_create(post=post, user=request.user)
    if not created:
        obj.delete()
    return {'saved': created}


@api(['GET'])
def post_likers(request, pk):
    post = _visible_post(request, pk)
    if post.hide_likes and post.author_id != request.user.pk:
        return {'results': []}
    likes = post.likes.select_related('user').order_by('-created_at')[:500]
    return {'results': [user_brief(l.user, request.user) for l in likes]}


def comment_queryset(viewer):
    return (Comment.objects.select_related('user')
            .annotate(like_count=Count('likes', distinct=True), reply_count=Count('replies', distinct=True),
                      liked=Exists(CommentLike.objects.filter(comment=OuterRef('pk'), user=viewer))))


@api(['GET', 'POST'])
def comments(request, pk):
    post = _visible_post(request, pk)
    if request.method == 'GET':
        parent = as_int(request.GET.get('parent'))
        qs = comment_queryset(request.user).filter(post=post, parent_id=parent).exclude(user_id__in=blocked_ids(request.user))
        order = 'created_at' if parent else '-created_at'
        return {'results': [comment_data(c, request.user) for c in qs.order_by(order)[:300]]}
    if post.comments_disabled:
        raise ApiError('Les commentaires sont désactivés.', 403)
    rate_limit(request, 'comment', 60, 300)
    data = body(request)
    text = (data.get('text') or '').strip()
    if not text:
        raise ApiError('Commentaire vide.')
    parent = None
    if as_int(data.get('parent_id')):
        parent = get_object_or_404(Comment, pk=as_int(data.get('parent_id')), post=post)
        parent = parent.parent or parent  # un seul niveau de réponses
    c = Comment.objects.create(post=post, user=request.user, text=text[:2200], parent=parent)
    notify(post.author, request.user, 'comment', post=post, comment=c)
    if parent and parent.user_id != post.author_id:
        notify(parent.user, request.user, 'reply', post=post, comment=c)
    notify_mentions(text, request.user, post, c)
    return comment_data(comment_queryset(request.user).get(pk=c.pk), request.user)


@api(['POST', 'DELETE'])
def comment_action(request, pk):
    c = get_object_or_404(Comment.objects.select_related('post'), pk=pk)
    if not can_view_post(request.user, c.post):
        raise ApiError('Introuvable.', 404)
    if request.method == 'DELETE':
        if request.user.pk not in (c.user_id, c.post.author_id):
            raise ApiError('Accès refusé.', 403)
        c.delete()
        return {'ok': True}
    like = CommentLike.objects.filter(comment=c, user=request.user).first()
    if like:
        like.delete()
    else:
        CommentLike.objects.create(comment=c, user=request.user)
        notify(c.user, request.user, 'comment_like', post=c.post, comment=c)
    return {'liked': like is None, 'like_count': c.likes.count()}


# ---------------------------------------------------------------- Stories / Statuts

def story_audience_ids(viewer):
    """Auteurs dont `viewer` peut voir les stories : suivis + contacts de discussion."""
    followed = set(Follow.objects.filter(follower=viewer, accepted=True).values_list('following_id', flat=True))
    return (followed | contact_ids(viewer) | {viewer.pk}) - blocked_ids(viewer)


def visible_stories(viewer):
    now = timezone.now()
    close_owner_ids = CloseFriend.objects.filter(friend=viewer).values('owner_id')
    return (Story.objects.filter(user_id__in=story_audience_ids(viewer), expires_at__gt=now)
            .filter(Q(close_friends_only=False) | Q(user=viewer) | Q(user_id__in=close_owner_ids))
            .select_related('user')
            .annotate(seen=Exists(StoryView.objects.filter(story=OuterRef('pk'), user=viewer)),
                      liked_by_me=Exists(StoryView.objects.filter(story=OuterRef('pk'), user=viewer, liked=True)),
                      view_count=Count('views', distinct=True)))


@api(['GET', 'POST'])
def stories(request):
    if request.method == 'POST':
        return create_story(request)
    groups = {}
    for s in visible_stories(request.user).order_by('created_at'):
        g = groups.setdefault(s.user_id, {'user': user_brief(s.user, request.user), 'stories': []})
        g['stories'].append(story_data(s, request.user))
    result = []
    for uid, g in groups.items():
        g['all_seen'] = all(s['seen'] for s in g['stories'])
        g['is_me'] = uid == request.user.pk
        g['latest'] = g['stories'][-1]['created_at']
        result.append(g)
    result.sort(key=lambda g: (g['is_me'], not g['all_seen'], g['latest']), reverse=True)
    return {'results': result}


def create_story(request):
    rate_limit(request, 'story', 50, 3600)
    data = request.POST
    upload = request.FILES.get('file')
    story = Story(user=request.user, close_friends_only=as_bool(data.get('close_friends_only')),
                  text=(data.get('text') or '')[:700], background=(data.get('background') or '#128C7E')[:32])
    if upload:
        kind = media_kind(upload)
        if kind not in ('image', 'video'):
            raise ApiError('Une story doit être une photo ou une vidéo.')
        story.kind = kind
        story.file = upload
    else:
        if not story.text.strip():
            raise ApiError('Story vide.')
        story.kind = 'text'
    story.save()
    audience = story_audience_viewers(request.user, story)
    push(audience, 'story.new', {'user_id': request.user.pk})
    return story_data(story, request.user)


def story_audience_viewers(owner, story):
    followers = set(Follow.objects.filter(following=owner, accepted=True).values_list('follower_id', flat=True))
    ids = followers | contact_ids(owner) | {owner.pk}
    if story.close_friends_only:
        ids = set(CloseFriend.objects.filter(owner=owner).values_list('friend_id', flat=True)) | {owner.pk}
    return ids


def _visible_story(request, pk):
    story = visible_stories(request.user).filter(pk=pk).first()
    if story is None:
        raise ApiError('Story introuvable ou expirée.', 404)
    return story


@api(['POST', 'DELETE'])
def story_action(request, pk):
    story = _visible_story(request, pk)
    if request.method == 'DELETE':
        if story.user_id != request.user.pk:
            raise ApiError('Accès refusé.', 403)
        if story.file:
            story.file.delete(save=False)
        story.delete()
        return {'ok': True}
    action = body(request).get('action', 'view')
    if story.user_id == request.user.pk:
        return {'ok': True}
    view, _ = StoryView.objects.get_or_create(story=story, user=request.user)
    if action == 'like':
        view.liked = not view.liked
        view.save(update_fields=['liked'])
        if view.liked:
            notify(story.user, request.user, 'story_like')
    push([story.user_id], 'story.viewed', {'story_id': story.pk, 'user_id': request.user.pk})
    return {'liked': view.liked}


@api(['GET'])
def story_viewers(request, pk):
    story = get_object_or_404(Story, pk=pk, user=request.user)
    views = story.views.select_related('user').order_by('-viewed_at')
    return {'results': [dict(user_brief(v.user, request.user), liked=v.liked, viewed_at=v.viewed_at.isoformat()) for v in views]}


# ---------------------------------------------------------------- Notifications

@api(['GET', 'POST'])
def notifications(request):
    if request.method == 'POST':
        Notification.objects.filter(recipient=request.user, read=False).update(read=True)
        return {'ok': True}
    qs = (Notification.objects.filter(recipient=request.user).select_related('actor', 'comment', 'post')
          .prefetch_related('post__media').order_by('-created_at')[:100])
    return {
        'results': [notification_data(n, request.user) for n in qs],
        'unread': Notification.objects.filter(recipient=request.user, read=False).count(),
        'requests': Follow.objects.filter(following=request.user, accepted=False).count(),
    }
