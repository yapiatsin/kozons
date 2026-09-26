from django.contrib import admin
from django.contrib.auth.admin import UserAdmin
from django.utils import timezone
from django.utils.html import format_html

from .models import Block, OneTimeCode, User


def thumb(url, size=36, round_=True):
    if not url:
        return '—'
    radius = '50%' if round_ else '6px'
    return format_html('<img src="{}" style="width:{}px;height:{}px;object-fit:cover;border-radius:{}">', url, size, size, radius)


@admin.register(User)
class KozonsUserAdmin(UserAdmin):
    list_display = ('avatar_thumb', 'username', 'display_name', 'email', 'phone', 'is_online', 'last_seen',
                    'is_private', 'is_active', 'is_staff', 'date_joined')
    list_display_links = ('avatar_thumb', 'username')
    list_filter = ('is_active', 'is_staff', 'is_superuser', 'is_private', 'read_receipts',
                   'last_seen_visibility', 'avatar_visibility', 'date_joined')
    search_fields = ('username', 'display_name', 'email', 'phone', 'first_name', 'last_name')
    ordering = ('-date_joined',)
    date_hierarchy = 'date_joined'
    readonly_fields = ('avatar_preview', 'last_seen', 'last_login', 'date_joined')
    fieldsets = (
        (None, {'fields': ('username', 'password')}),
        ('Profil', {'fields': ('display_name', 'email', 'phone', 'avatar', 'avatar_preview', 'about', 'bio', 'website')}),
        ('Confidentialité', {'fields': ('is_private', 'last_seen_visibility', 'avatar_visibility', 'read_receipts')}),
        ('Présence', {'fields': ('last_seen',)}),
        ('Permissions', {'classes': ('collapse',), 'fields': ('is_active', 'is_staff', 'is_superuser', 'groups', 'user_permissions')}),
        ('Dates', {'fields': ('last_login', 'date_joined')}),
    )
    add_fieldsets = (
        (None, {'classes': ('wide',), 'fields': ('username', 'email', 'display_name', 'password1', 'password2')}),
    )

    @admin.display(description='Photo')
    def avatar_thumb(self, obj):
        return thumb(obj.avatar.url if obj.avatar else None)

    @admin.display(description='Aperçu')
    def avatar_preview(self, obj):
        return thumb(obj.avatar.url if obj.avatar else None, 120)

    @admin.display(description='En ligne', boolean=True)
    def is_online(self, obj):
        return obj.is_online


@admin.register(Block)
class BlockAdmin(admin.ModelAdmin):
    list_display = ('id', 'blocker', 'blocked', 'created_at')
    search_fields = ('blocker__username', 'blocked__username')
    autocomplete_fields = ('blocker', 'blocked')
    list_select_related = ('blocker', 'blocked')
    date_hierarchy = 'created_at'
    ordering = ('-created_at',)


@admin.register(OneTimeCode)
class OneTimeCodeAdmin(admin.ModelAdmin):
    """Codes de réinitialisation : consultables mais jamais modifiables (seule leur empreinte est stockée)."""
    list_display = ('id', 'user', 'purpose', 'status', 'attempts', 'created_at', 'expires_at', 'used_at')
    list_filter = ('purpose', ('used_at', admin.EmptyFieldListFilter), 'created_at')
    search_fields = ('user__username', 'user__email')
    list_select_related = ('user',)
    date_hierarchy = 'created_at'
    ordering = ('-created_at',)
    readonly_fields = ('user', 'purpose', 'attempts', 'created_at', 'expires_at', 'used_at')
    exclude = ('code_hash',)
    actions = ('invalidate',)

    @admin.display(description='État')
    def status(self, obj):
        if obj.used_at:
            return 'Utilisé / invalidé'
        return 'Actif' if obj.expires_at > timezone.now() else 'Expiré'

    @admin.action(description='Invalider les codes sélectionnés')
    def invalidate(self, request, queryset):
        count = queryset.filter(used_at__isnull=True).update(used_at=timezone.now())
        self.message_user(request, f'{count} code(s) invalidé(s).')

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
