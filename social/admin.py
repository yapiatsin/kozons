from django.contrib import admin
from django.db.models import Count
from django.utils import timezone
from django.utils.html import format_html
from django.utils.text import Truncator

from accounts.admin import thumb

from .models import (CloseFriend, Comment, CommentLike, Follow, Like, Notification, Post, PostMedia, SavedPost,
                     Story, StoryView)


# ---------------------------------------------------------------- Abonnements

@admin.register(Follow)
class FollowAdmin(admin.ModelAdmin):
    list_display = ('id', 'follower', 'following', 'accepted', 'created_at')
    list_filter = ('accepted', 'created_at')
    search_fields = ('follower__username', 'following__username')
    autocomplete_fields = ('follower', 'following')
    list_select_related = ('follower', 'following')
    date_hierarchy = 'created_at'
    ordering = ('-created_at',)
    actions = ('accept',)

    @admin.action(description='Accepter les demandes sélectionnées')
    def accept(self, request, queryset):
        self.message_user(request, f'{queryset.filter(accepted=False).update(accepted=True)} demande(s) acceptée(s).')


@admin.register(CloseFriend)
class CloseFriendAdmin(admin.ModelAdmin):
    list_display = ('id', 'owner', 'friend')
    search_fields = ('owner__username', 'friend__username')
    autocomplete_fields = ('owner', 'friend')
    list_select_related = ('owner', 'friend')


# ---------------------------------------------------------------- Publications

class PostMediaInline(admin.TabularInline):
    model = PostMedia
    extra = 0
    fields = ('order', 'kind', 'file', 'preview')
    readonly_fields = ('preview',)

    @admin.display(description='Aperçu')
    def preview(self, obj):
        if not obj.pk or not obj.file:
            return '—'
        if obj.kind == 'video':
            return format_html('<video src="{}" style="max-width:160px" controls></video>', obj.file.url)
        return thumb(obj.file.url, 80, round_=False)


class CommentInline(admin.TabularInline):
    model = Comment
    extra = 0
    fields = ('user', 'text', 'parent', 'created_at')
    readonly_fields = ('created_at',)
    autocomplete_fields = ('user', 'parent')
    show_change_link = True


@admin.register(Post)
class PostAdmin(admin.ModelAdmin):
    list_display = ('id', 'cover', 'author', 'short_caption', 'post_type', 'media_count', 'like_count', 'comment_count',
                    'archived', 'comments_disabled', 'hide_likes', 'created_at')
    list_display_links = ('id', 'cover', 'short_caption')
    list_filter = ('is_reel', 'archived', 'comments_disabled', 'hide_likes', 'created_at')
    search_fields = ('caption', 'location', 'author__username')
    autocomplete_fields = ('author',)
    date_hierarchy = 'created_at'
    ordering = ('-created_at',)
    fieldsets = (
        (None, {'fields': ('author', 'caption', 'location', 'is_reel')}),
        ('Paramètres', {'fields': ('comments_disabled', 'hide_likes', 'archived', 'created_at')}),
    )
    inlines = [PostMediaInline, CommentInline]

    def get_queryset(self, request):
        return (super().get_queryset(request).select_related('author').prefetch_related('media')
                .annotate(_likes=Count('likes', distinct=True), _comments=Count('comments', distinct=True),
                          _media=Count('media', distinct=True)))

    @admin.display(description='Média')
    def cover(self, obj):
        first = next(iter(obj.media.all()), None)
        if first is None:
            return '—'
        if first.kind == 'video':
            return '🎥'
        return thumb(first.file.url, 48, round_=False)

    @admin.display(description='Légende')
    def short_caption(self, obj):
        return Truncator(obj.caption).chars(60) or '—'

    @admin.display(description='Type', ordering='is_reel')
    def post_type(self, obj):
        return 'Reel' if obj.is_reel else 'Publication'

    @admin.display(description='Médias', ordering='_media')
    def media_count(self, obj):
        return obj._media

    @admin.display(description="J'aime", ordering='_likes')
    def like_count(self, obj):
        return obj._likes

    @admin.display(description='Commentaires', ordering='_comments')
    def comment_count(self, obj):
        return obj._comments


@admin.register(PostMedia)
class PostMediaAdmin(admin.ModelAdmin):
    list_display = ('id', 'preview', 'post', 'kind', 'order')
    list_filter = ('kind',)
    search_fields = ('post__caption', 'post__author__username')
    autocomplete_fields = ('post',)
    list_select_related = ('post',)

    @admin.display(description='Aperçu')
    def preview(self, obj):
        return '🎥' if obj.kind == 'video' else thumb(obj.file.url, 48, round_=False)


@admin.register(Like)
class LikeAdmin(admin.ModelAdmin):
    list_display = ('id', 'user', 'post', 'created_at')
    search_fields = ('user__username', 'post__caption')
    autocomplete_fields = ('user', 'post')
    list_select_related = ('user', 'post')
    date_hierarchy = 'created_at'
    ordering = ('-created_at',)


@admin.register(SavedPost)
class SavedPostAdmin(admin.ModelAdmin):
    list_display = ('id', 'user', 'post', 'created_at')
    search_fields = ('user__username', 'post__caption')
    autocomplete_fields = ('user', 'post')
    list_select_related = ('user', 'post')
    date_hierarchy = 'created_at'
    ordering = ('-created_at',)


@admin.register(Comment)
class CommentAdmin(admin.ModelAdmin):
    list_display = ('id', 'user', 'short_text', 'post', 'is_reply', 'like_count', 'created_at')
    list_filter = (('parent', admin.EmptyFieldListFilter), 'created_at')
    search_fields = ('text', 'user__username', 'post__caption')
    autocomplete_fields = ('user', 'post', 'parent')
    list_select_related = ('user', 'post')
    date_hierarchy = 'created_at'
    ordering = ('-created_at',)

    def get_queryset(self, request):
        return super().get_queryset(request).annotate(_likes=Count('likes'))

    @admin.display(description='Commentaire')
    def short_text(self, obj):
        return Truncator(obj.text).chars(80)

    @admin.display(description='Réponse', boolean=True)
    def is_reply(self, obj):
        return obj.parent_id is not None

    @admin.display(description="J'aime", ordering='_likes')
    def like_count(self, obj):
        return obj._likes


@admin.register(CommentLike)
class CommentLikeAdmin(admin.ModelAdmin):
    list_display = ('id', 'user', 'comment')
    search_fields = ('user__username', 'comment__text')
    autocomplete_fields = ('user', 'comment')
    list_select_related = ('user', 'comment')


# ---------------------------------------------------------------- Stories

class StoryViewInline(admin.TabularInline):
    model = StoryView
    extra = 0
    fields = ('user', 'liked', 'viewed_at')
    readonly_fields = ('user', 'liked', 'viewed_at')
    can_delete = False

    def has_add_permission(self, request, obj=None):
        return False


@admin.register(Story)
class StoryAdmin(admin.ModelAdmin):
    list_display = ('id', 'preview', 'user', 'kind', 'short_text', 'close_friends_only', 'view_count', 'active',
                    'created_at', 'expires_at')
    list_display_links = ('id', 'preview')
    list_filter = ('kind', 'close_friends_only', 'created_at')
    search_fields = ('text', 'user__username')
    autocomplete_fields = ('user',)
    date_hierarchy = 'created_at'
    ordering = ('-created_at',)
    inlines = [StoryViewInline]

    def get_queryset(self, request):
        return super().get_queryset(request).select_related('user').annotate(_views=Count('views'))

    @admin.display(description='Aperçu')
    def preview(self, obj):
        if obj.kind == 'text':
            return format_html('<span style="display:inline-block;width:32px;height:48px;border-radius:4px;background:{}"></span>', obj.background)
        if obj.kind == 'video':
            return '🎥'
        return thumb(obj.file.url if obj.file else None, 40, round_=False)

    @admin.display(description='Texte')
    def short_text(self, obj):
        return Truncator(obj.text).chars(50) or '—'

    @admin.display(description='Vues', ordering='_views')
    def view_count(self, obj):
        return obj._views

    @admin.display(description='Active', boolean=True, ordering='expires_at')
    def active(self, obj):
        return obj.expires_at > timezone.now()


@admin.register(StoryView)
class StoryViewAdmin(admin.ModelAdmin):
    list_display = ('id', 'story', 'user', 'liked', 'viewed_at')
    list_filter = ('liked', 'viewed_at')
    search_fields = ('user__username', 'story__user__username')
    autocomplete_fields = ('story', 'user')
    list_select_related = ('story', 'user')
    date_hierarchy = 'viewed_at'
    ordering = ('-viewed_at',)


# ---------------------------------------------------------------- Notifications

@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = ('id', 'recipient', 'actor', 'verb', 'post', 'short_comment', 'read', 'created_at')
    list_filter = ('verb', 'read', 'created_at')
    search_fields = ('recipient__username', 'actor__username')
    autocomplete_fields = ('recipient', 'actor', 'post', 'comment')
    list_select_related = ('recipient', 'actor', 'post', 'comment')
    date_hierarchy = 'created_at'
    ordering = ('-created_at',)
    actions = ('mark_read',)

    @admin.display(description='Commentaire')
    def short_comment(self, obj):
        return Truncator(obj.comment.text).chars(40) if obj.comment_id else '—'

    @admin.action(description='Marquer comme lues')
    def mark_read(self, request, queryset):
        self.message_user(request, f'{queryset.update(read=True)} notification(s) marquée(s) comme lue(s).')
