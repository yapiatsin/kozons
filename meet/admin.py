from django.contrib import admin

from .models import Meeting, MeetingAttendance, MeetingInvite, MeetingMessage, MeetingNotes, TranscriptLine


class InviteInline(admin.TabularInline):
    model = MeetingInvite
    extra = 0
    raw_id_fields = ['user']


@admin.register(Meeting)
class MeetingAdmin(admin.ModelAdmin):
    list_display = ['code', 'title', 'host', 'scheduled_at', 'access', 'created_at', 'cancelled']
    list_filter = ['access', 'cancelled']
    search_fields = ['code', 'title', 'host__username']
    raw_id_fields = ['host']
    inlines = [InviteInline]


@admin.register(MeetingAttendance)
class AttendanceAdmin(admin.ModelAdmin):
    list_display = ['meeting', 'user', 'joined_at', 'left_at']
    raw_id_fields = ['meeting', 'user']


@admin.register(MeetingMessage)
class MessageAdmin(admin.ModelAdmin):
    list_display = ['meeting', 'user', 'text', 'created_at']
    raw_id_fields = ['meeting', 'user']


class LineInline(admin.TabularInline):
    model = TranscriptLine
    extra = 0
    fields = ['spoken_at', 'speaker', 'text']
    readonly_fields = fields


@admin.register(MeetingNotes)
class NotesAdmin(admin.ModelAdmin):
    list_display = ['meeting', 'started_at', 'ended_at', 'status', 'model']
    list_filter = ['status']
    raw_id_fields = ['meeting', 'started_by']
    filter_horizontal = ['recipients']
    inlines = [LineInline]
