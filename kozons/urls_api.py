from django.urls import path

from accounts import views as accounts
from chat import stickers
from chat import views as chat
from live import views as live
from social import views as social

urlpatterns = [
    # Comptes
    path('auth/register', accounts.register),
    path('auth/login', accounts.login_view),
    path('auth/login/verify', accounts.login_verify),
    path('auth/login/resend', accounts.login_resend),
    path('auth/logout', accounts.logout_view),
    path('auth/password', accounts.change_password),
    path('auth/password/forgot', accounts.password_forgot),
    path('auth/password/verify', accounts.password_verify),
    path('auth/password/reset', accounts.password_reset),
    path('me', accounts.me),
    path('presence/heartbeat', accounts.presence_heartbeat),
    path('push/key', accounts.push_key),
    path('push/subscribe', accounts.push_subscribe),
    path('push/unsubscribe', accounts.push_unsubscribe),
    path('push/test', accounts.push_test),
    path('users/search', accounts.search_users),
    path('users/blocked', accounts.blocked_list),
    path('users/<int:user_id>/block', accounts.toggle_block),
    path('users/<int:user_id>/follow', social.toggle_follow),
    path('users/<int:user_id>/follow-request', social.follow_request),
    path('users/<int:user_id>/remove-follower', social.remove_follower),
    path('users/<int:user_id>/close-friend', social.toggle_close_friend),
    path('follow-requests', social.follow_requests),
    path('suggestions', social.suggestions),
    path('profiles/<str:username>', social.profile),
    path('profiles/<str:username>/posts', social.profile_posts),
    path('profiles/<str:username>/<str:which>', social.follow_list),

    # Discussions
    path('conversations', chat.conversation_list),
    path('conversations/direct', chat.start_direct),
    path('conversations/group', chat.create_group),
    path('conversations/<int:pk>', chat.conversation_detail),
    path('conversations/<int:pk>/update', chat.update_conversation),
    path('conversations/<int:pk>/settings', chat.conversation_settings),
    path('conversations/<int:pk>/members', chat.manage_members),
    path('conversations/<int:pk>/messages', chat.messages),
    path('conversations/<int:pk>/read', chat.read),
    path('conversations/<int:pk>/media', chat.media_gallery),
    path('messages/starred', chat.starred_list),
    path('messages/search', chat.search),
    path('messages/<int:pk>/edit', chat.edit_message),
    path('messages/<int:pk>/delete', chat.delete_message),
    path('messages/<int:pk>/react', chat.react),
    path('messages/<int:pk>/star', chat.star),
    path('messages/<int:pk>/forward', chat.forward),
    path('messages/<int:pk>/vote', chat.vote),
    path('messages/<int:pk>/open', chat.open_view_once),
    path('messages/<int:pk>/info', chat.message_info),
    path('messages/<int:pk>/sticker', stickers.sticker_from_message),
    path('stickers', stickers.sticker_collection),
    path('stickers/<int:pk>', stickers.sticker_action),
    path('calls', chat.call_history),
    path('calls/ice', chat.ice_servers),

    # Lives
    path('live', live.lives),
    path('live/media-auth', live.media_auth),
    path('live/<int:pk>', live.live_detail),
    path('live/<int:pk>/end', live.live_end),
    path('live/<int:pk>/viewers', live.live_viewers),

    # Social
    path('feed', social.feed),
    path('explore', social.explore),
    path('reels', social.reels),
    path('posts', social.create_post),
    path('posts/<int:pk>', social.post_detail),
    path('posts/<int:pk>/like', social.like_post),
    path('posts/<int:pk>/save', social.save_post),
    path('posts/<int:pk>/likers', social.post_likers),
    path('posts/<int:pk>/comments', social.comments),
    path('comments/<int:pk>', social.comment_action),
    path('stories', social.stories),
    path('stories/<int:pk>', social.story_action),
    path('stories/<int:pk>/viewers', social.story_viewers),
    path('notifications', social.notifications),
]
