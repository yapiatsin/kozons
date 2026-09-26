from django.contrib import admin
from django.utils import timezone
from django.utils.text import Truncator

from accounts.admin import thumb

from . import registry, services
from .models import GIFTS, LiveBan, LiveComment, LiveGift, LiveStream, LiveViewer


def _duration(live):
    end = live.ended_at or timezone.now()
    seconds = int((end - live.started_at).total_seconds())
    h, rest = divmod(seconds, 3600)
    return f'{h}:{rest // 60:02d}:{rest % 60:02d}' if h else f'{rest // 60}:{rest % 60:02d}'


class LiveCommentInline(admin.TabularInline):
    model = LiveComment
    extra = 0
    fields = ('user', 'text', 'reply_to', 'created_at')
    readonly_fields = ('user', 'text', 'reply_to', 'created_at')
    ordering = ('-created_at',)
    show_change_link = True

    def has_add_permission(self, request, obj=None):
        return False


class LiveGiftInline(admin.TabularInline):
    model = LiveGift
    extra = 0
    fields = ('sender', 'gift', 'created_at')
    readonly_fields = ('sender', 'gift', 'created_at')

    def has_add_permission(self, request, obj=None):
        return False


class LiveBanInline(admin.TabularInline):
    model = LiveBan
    extra = 0
    fields = ('user', 'created_at')
    readonly_fields = ('created_at',)
    autocomplete_fields = ('user',)


@admin.register(LiveStream)
class LiveStreamAdmin(admin.ModelAdmin):
    list_display = ('id', 'host_thumb', 'host', 'short_title', 'status_label', 'audience', 'current_viewers', 'peak_viewers',
                    'total_viewers', 'likes_count', 'comments_count', 'gifts_count', 'gifts_value', 'new_followers',
                    'duration', 'started_at')
    list_display_links = ('id', 'host_thumb', 'short_title')
    list_filter = ('status', 'audience', 'started_at')
    search_fields = ('title', 'host__username', 'host__display_name')
    date_hierarchy = 'started_at'
    ordering = ('-started_at',)
    list_select_related = ('host',)
    autocomplete_fields = ('host',)
    readonly_fields = ('media_key', 'started_at', 'ended_at', 'host_seen_at', 'pinned_comment', 'likes_count', 'comments_count',
                       'gifts_count', 'gifts_value', 'peak_viewers', 'total_viewers', 'new_followers', 'duration', 'current_viewers')
    fieldsets = (
        (None, {'fields': ('host', 'title', 'audience', 'status')}),
        ('Statistiques', {'fields': (('current_viewers', 'peak_viewers', 'total_viewers'), ('likes_count', 'comments_count'),
                                     ('gifts_count', 'gifts_value'), 'new_followers')}),
        ('Déroulement', {'fields': ('started_at', 'ended_at', 'duration', 'host_seen_at', 'pinned_comment')}),
        ('Technique', {'classes': ('collapse',), 'fields': ('media_key',)}),
    )
    inlines = [LiveCommentInline, LiveGiftInline, LiveBanInline]
    actions = ('end_lives',)

    @admin.display(description='Photo')
    def host_thumb(self, obj):
        return thumb(obj.host.avatar.url if obj.host.avatar else None)

    @admin.display(description='Titre')
    def short_title(self, obj):
        return Truncator(obj.title).chars(50) or '—'

    @admin.display(description='Statut', ordering='status')
    def status_label(self, obj):
        return '🔴 En direct' if obj.is_live else 'Terminé'

    @admin.display(description='Spectateurs actuels')
    def current_viewers(self, obj):
        return registry.count(obj.pk) if obj.is_live else 0

    @admin.display(description='Durée')
    def duration(self, obj):
        return _duration(obj)

    @admin.action(description='Terminer les lives sélectionnés')
    def end_lives(self, request, queryset):
        count = 0
        for live in queryset.filter(status=LiveStream.LIVE):
            services.end_live(live, reason='admin')
            count += 1
        self.message_user(request, f'{count} live(s) terminé(s).')


@admin.register(LiveComment)
class LiveCommentAdmin(admin.ModelAdmin):
    list_display = ('id', 'live', 'user', 'short_text', 'is_reply', 'created_at')
    list_filter = (('reply_to', admin.EmptyFieldListFilter), 'created_at')
    search_fields = ('text', 'user__username', 'live__title', 'live__host__username')
    date_hierarchy = 'created_at'
    ordering = ('-created_at',)
    list_select_related = ('live', 'user')
    autocomplete_fields = ('live', 'user', 'reply_to')

    @admin.display(description='Commentaire')
    def short_text(self, obj):
        return Truncator(obj.text).chars(80)

    @admin.display(description='Réponse', boolean=True)
    def is_reply(self, obj):
        return obj.reply_to_id is not None


@admin.register(LiveGift)
class LiveGiftAdmin(admin.ModelAdmin):
    list_display = ('id', 'live', 'sender', 'gift_label', 'value', 'created_at')
    list_filter = ('gift', 'created_at')
    search_fields = ('sender__username', 'live__host__username', 'live__title')
    date_hierarchy = 'created_at'
    ordering = ('-created_at',)
    list_select_related = ('live', 'sender')
    autocomplete_fields = ('live', 'sender')

    @admin.display(description='Cadeau', ordering='gift')
    def gift_label(self, obj):
        g = GIFTS.get(obj.gift, {})
        return f"{g.get('emoji', '')} {g.get('name', obj.gift)}"

    @admin.display(description='Valeur (💎)')
    def value(self, obj):
        return GIFTS.get(obj.gift, {}).get('value', 0)


@admin.register(LiveViewer)
class LiveViewerAdmin(admin.ModelAdmin):
    """Spectateurs uniques de chaque live (une ligne par personne et par live)."""
    list_display = ('id', 'live', 'user', 'joined_at')
    search_fields = ('user__username', 'live__host__username', 'live__title')
    date_hierarchy = 'joined_at'
    ordering = ('-joined_at',)
    list_select_related = ('live', 'user')
    autocomplete_fields = ('live', 'user')


@admin.register(LiveBan)
class LiveBanAdmin(admin.ModelAdmin):
    list_display = ('id', 'live', 'user', 'created_at')
    search_fields = ('user__username', 'live__host__username')
    date_hierarchy = 'created_at'
    ordering = ('-created_at',)
    list_select_related = ('live', 'user')
    autocomplete_fields = ('live', 'user')
