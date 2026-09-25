from django.urls import path, re_path

from . import views

urlpatterns = [
    path('sw.js', views.service_worker),
    path('manifest.webmanifest', views.manifest),
    re_path(r'^(?!api/|media/|static/|admin/|ws/).*$', views.app),
]
