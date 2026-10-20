from django.contrib import admin

from .models import Message, Thread


class MessageInline(admin.TabularInline):
    model = Message
    extra = 0
    fields = ['created_at', 'role', 'content']
    readonly_fields = fields


@admin.register(Thread)
class ThreadAdmin(admin.ModelAdmin):
    list_display = ['title', 'user', 'updated_at']
    search_fields = ['title', 'user__username']
    raw_id_fields = ['user']
    inlines = [MessageInline]
