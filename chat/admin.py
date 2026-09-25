from django.contrib import admin
from django.db.models import Count
from django.utils.html import format_html
from django.utils.text import Truncator

from accounts.admin import thumb

from .models import (Call, Conversation, HiddenMessage, Message, Participant, PollOption, PollVote, Reaction,
                     StarredMessage, Sticker, UserSticker, ViewOnceOpened)


# ---------------------------------------------------------------- Discussions

class ParticipantInline(admin.TabularInline):
    model = Participant
    extra = 0
    fields = ('user', 'role', 'joined_at', 'pinned', 'archived', 'muted_until', 'last_read_id', 'last_delivered_id')
    readonly_fields = ('joined_at', 'last_read_id', 'last_delivered_id')
    autocomplete_fields = ('user',)


@admin.register(Conversation)
class ConversationAdmin(admin.ModelAdmin):
    list_display = ('id', 'avatar_thumb', 'name', 'kind', 'member_count', 'message_count', 'disappearing',
                    'only_admins_can_send', 'created_by', 'created_at', 'updated_at')
    list_display_links = ('id', 'avatar_thumb', 'name')
    list_filter = ('kind', 'only_admins_can_send', 'only_admins_can_edit', 'disappearing_seconds', 'created_at')
    search_fields = ('title', 'description', 'participants__user__username')
    date_hierarchy = 'updated_at'
    ordering = ('-updated_at',)
    readonly_fields = ('direct_key', 'created_by', 'created_at', 'updated_at')
    fieldsets = (
        (None, {'fields': ('kind', 'title', 'description', 'avatar')}),
        ('Paramètres', {'fields': ('only_admins_can_send', 'only_admins_can_edit', 'disappearing_seconds')}),
        ('Informations', {'fields': ('direct_key', 'created_by', 'created_at', 'updated_at')}),
    )
    inlines = [ParticipantInline]

    def get_queryset(self, request):
        return (super().get_queryset(request).select_related('created_by')
                .prefetch_related('participants__user')
                .annotate(_members=Count('participants', distinct=True), _messages=Count('messages', distinct=True)))

    @admin.display(description='Icône')
    def avatar_thumb(self, obj):
        return thumb(obj.avatar.url if obj.avatar else None)

    @admin.display(description='Nom')
    def name(self, obj):
        if obj.is_group:
            return obj.title
        return ' ↔ '.join(p.user.username for p in obj.participants.all()) or '—'

    @admin.display(description='Membres', ordering='_members')
    def member_count(self, obj):
        return obj._members

    @admin.display(description='Messages', ordering='_messages')
    def message_count(self, obj):
        return obj._messages

    @admin.display(description='Éphémères', ordering='disappearing_seconds')
    def disappearing(self, obj):
        return {0: '—', 86400: '24 h', 604800: '7 j', 7776000: '90 j'}.get(obj.disappearing_seconds, f'{obj.disappearing_seconds} s')


@admin.register(Participant)
class ParticipantAdmin(admin.ModelAdmin):
    list_display = ('id', 'conversation', 'user', 'role', 'joined_at', 'pinned', 'archived', 'muted_until', 'marked_unread')
    list_filter = ('role', 'pinned', 'archived', 'marked_unread', 'conversation__kind')
    search_fields = ('user__username', 'conversation__title')
    autocomplete_fields = ('conversation', 'user')
    list_select_related = ('conversation', 'user')
    readonly_fields = ('joined_at', 'last_read_id', 'last_delivered_id', 'cleared_before_id')
    ordering = ('-joined_at',)


# ---------------------------------------------------------------- Messages

class ReactionInline(admin.TabularInline):
    model = Reaction
    extra = 0
    autocomplete_fields = ('user',)


class PollOptionInline(admin.TabularInline):
    model = PollOption
    extra = 0
    fields = ('text', 'multiple', 'vote_count')
    readonly_fields = ('vote_count',)

    @admin.display(description='Votes')
    def vote_count(self, obj):
        return obj.votes.count() if obj.pk else 0


@admin.register(Message)
class MessageAdmin(admin.ModelAdmin):
    list_display = ('id', 'conversation', 'sender', 'kind', 'preview', 'media_thumb', 'forwarded', 'view_once',
                    'edited', 'deleted', 'created_at', 'expires_at')
    list_filter = ('kind', 'deleted', 'forwarded', 'view_once', ('edited_at', admin.EmptyFieldListFilter),
                   ('expires_at', admin.EmptyFieldListFilter), 'created_at')
    search_fields = ('text', 'file_name', 'sender__username', 'conversation__title')
    date_hierarchy = 'created_at'
    ordering = ('-id',)
    list_select_related = ('conversation', 'sender')
    autocomplete_fields = ('conversation', 'sender', 'reply_to', 'contact_user', 'sticker', 'shared_post', 'story')
    readonly_fields = ('media_preview', 'file_size', 'created_at', 'edited_at')
    fieldsets = (
        (None, {'fields': ('conversation', 'sender', 'kind', 'text', 'reply_to')}),
        ('Fichier', {'fields': ('file', 'media_preview', 'file_name', 'file_size', 'duration', 'view_once', 'sticker')}),
        ('Contenu partagé', {'classes': ('collapse',), 'fields': ('latitude', 'longitude', 'contact_user', 'shared_post', 'story')}),
        ('État', {'fields': ('forwarded', 'deleted', 'created_at', 'edited_at', 'expires_at')}),
    )
    inlines = [ReactionInline, PollOptionInline]

    @admin.display(description='Contenu')
    def preview(self, obj):
        if obj.deleted:
            return '🚫 supprimé'
        return Truncator(obj.text).chars(60) if obj.text else (obj.file_name or '—')

    @admin.display(description='Média')
    def media_thumb(self, obj):
        if obj.file and obj.kind in ('image', 'sticker') and not obj.deleted:
            return thumb(obj.file.url, 40, round_=False)
        return '—'

    @admin.display(description='Aperçu')
    def media_preview(self, obj):
        if not obj.file:
            return '—'
        if obj.kind in ('image', 'sticker'):
            return thumb(obj.file.url, 200, round_=False)
        if obj.kind == 'video':
            return format_html('<video src="{}" controls style="max-width:320px"></video>', obj.file.url)
        if obj.kind in ('audio', 'voice'):
            return format_html('<audio src="{}" controls></audio>', obj.file.url)
        return format_html('<a href="{}" target="_blank">{}</a>', obj.file.url, obj.file_name or 'Ouvrir')

    @admin.display(description='Modifié', boolean=True)
    def edited(self, obj):
        return obj.edited_at is not None


@admin.register(Reaction)
class ReactionAdmin(admin.ModelAdmin):
    list_display = ('id', 'emoji', 'user', 'message')
    list_filter = ('emoji',)
    search_fields = ('user__username', 'emoji')
    autocomplete_fields = ('message', 'user')
    list_select_related = ('user', 'message')


@admin.register(StarredMessage)
class StarredMessageAdmin(admin.ModelAdmin):
    list_display = ('id', 'user', 'message', 'created_at')
    search_fields = ('user__username', 'message__text')
    autocomplete_fields = ('message', 'user')
    list_select_related = ('user', 'message')
    date_hierarchy = 'created_at'


@admin.register(HiddenMessage)
class HiddenMessageAdmin(admin.ModelAdmin):
    """Messages supprimés « pour moi »."""
    list_display = ('id', 'user', 'message')
    search_fields = ('user__username',)
    autocomplete_fields = ('message', 'user')
    list_select_related = ('user', 'message')


@admin.register(ViewOnceOpened)
class ViewOnceOpenedAdmin(admin.ModelAdmin):
    list_display = ('id', 'user', 'message')
    search_fields = ('user__username',)
    autocomplete_fields = ('message', 'user')
    list_select_related = ('user', 'message')


@admin.register(PollOption)
class PollOptionAdmin(admin.ModelAdmin):
    list_display = ('id', 'text', 'question', 'multiple', 'vote_count')
    search_fields = ('text', 'message__text')
    autocomplete_fields = ('message',)
    list_select_related = ('message',)

    def get_queryset(self, request):
        return super().get_queryset(request).annotate(_votes=Count('votes'))

    @admin.display(description='Question')
    def question(self, obj):
        return Truncator(obj.message.text).chars(60)

    @admin.display(description='Votes', ordering='_votes')
    def vote_count(self, obj):
        return obj._votes


@admin.register(PollVote)
class PollVoteAdmin(admin.ModelAdmin):
    list_display = ('id', 'user', 'option')
    search_fields = ('user__username', 'option__text')
    autocomplete_fields = ('option', 'user')
    list_select_related = ('user', 'option')


# ---------------------------------------------------------------- Stickers

class UserStickerInline(admin.TabularInline):
    model = UserSticker
    extra = 0
    fields = ('user', 'saved', 'favorite', 'last_used_at')
    readonly_fields = ('last_used_at',)
    autocomplete_fields = ('user',)


@admin.register(Sticker)
class StickerAdmin(admin.ModelAdmin):
    list_display = ('id', 'image', 'animated', 'created_by', 'owner_count', 'favorite_count', 'size', 'created_at')
    list_display_links = ('id', 'image')
    list_filter = ('animated', 'created_at')
    search_fields = ('sha256', 'created_by__username')
    date_hierarchy = 'created_at'
    ordering = ('-created_at',)
    readonly_fields = ('preview', 'file', 'sha256', 'animated', 'created_by', 'created_at')
    inlines = [UserStickerInline]

    def get_queryset(self, request):
        return (super().get_queryset(request).select_related('created_by')
                .annotate(_owners=Count('owners', distinct=True)))

    @admin.display(description='Sticker')
    def image(self, obj):
        return thumb(obj.file.url, 48, round_=False)

    @admin.display(description='Aperçu')
    def preview(self, obj):
        return thumb(obj.file.url, 256, round_=False)

    @admin.display(description='Utilisateurs', ordering='_owners')
    def owner_count(self, obj):
        return obj._owners

    @admin.display(description='En favori')
    def favorite_count(self, obj):
        return obj.owners.filter(favorite=True).count()

    @admin.display(description='Taille')
    def size(self, obj):
        try:
            return f'{obj.file.size / 1024:.0f} Ko'
        except OSError:
            return 'fichier manquant'


@admin.register(UserSticker)
class UserStickerAdmin(admin.ModelAdmin):
    list_display = ('id', 'user', 'sticker_image', 'saved', 'favorite', 'last_used_at', 'saved_at', 'favorited_at')
    list_filter = ('saved', 'favorite')
    search_fields = ('user__username',)
    autocomplete_fields = ('user', 'sticker')
    list_select_related = ('user', 'sticker')
    ordering = ('-last_used_at',)

    @admin.display(description='Sticker')
    def sticker_image(self, obj):
        return thumb(obj.sticker.file.url, 40, round_=False)


# ---------------------------------------------------------------- Appels

@admin.register(Call)
class CallAdmin(admin.ModelAdmin):
    list_display = ('id', 'caller', 'callee', 'call_type', 'status', 'started_at', 'answered_at', 'ended_at', 'duration')
    list_filter = ('status', 'video', 'started_at')
    search_fields = ('caller__username', 'callee__username')
    autocomplete_fields = ('caller', 'callee')
    list_select_related = ('caller', 'callee')
    date_hierarchy = 'started_at'
    ordering = ('-started_at',)
    readonly_fields = ('started_at', 'answered_at', 'ended_at')

    @admin.display(description='Type', ordering='video')
    def call_type(self, obj):
        return '🎥 Vidéo' if obj.video else '📞 Audio'

    @admin.display(description='Durée')
    def duration(self, obj):
        if not (obj.answered_at and obj.ended_at):
            return '—'
        seconds = int((obj.ended_at - obj.answered_at).total_seconds())
        return f'{seconds // 60}:{seconds % 60:02d}'
