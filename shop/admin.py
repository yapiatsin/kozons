from django.contrib import admin

from .models import (Category, Order, OrderEvent, OrderItem, Product, ProductImage, Shop, Subscription,
                     SubscriptionPayment)


class CategoryInline(admin.TabularInline):
    model = Category
    extra = 0


@admin.register(Shop)
class ShopAdmin(admin.ModelAdmin):
    list_display = ['name', 'owner', 'city', 'is_open', 'created_at']
    search_fields = ['name', 'owner__username']
    raw_id_fields = ['owner']
    inlines = [CategoryInline]


class ImageInline(admin.TabularInline):
    model = ProductImage
    extra = 0


@admin.register(Product)
class ProductAdmin(admin.ModelAdmin):
    list_display = ['title', 'shop', 'price', 'stock', 'is_active', 'sold_count']
    list_filter = ['is_active']
    search_fields = ['title', 'shop__name']
    raw_id_fields = ['shop', 'category']
    inlines = [ImageInline]


class ItemInline(admin.TabularInline):
    model = OrderItem
    extra = 0
    raw_id_fields = ['product']


class EventInline(admin.TabularInline):
    model = OrderEvent
    extra = 0


@admin.register(Order)
class OrderAdmin(admin.ModelAdmin):
    list_display = ['code', 'shop', 'buyer', 'status', 'items_total', 'delivery_fee', 'created_at']
    list_filter = ['status']
    search_fields = ['code', 'shop__name', 'buyer__username']
    raw_id_fields = ['buyer', 'shop']
    inlines = [ItemInline, EventInline]


@admin.register(Subscription)
class SubscriptionAdmin(admin.ModelAdmin):
    list_display = ['user', 'expires_at', 'started_at']
    search_fields = ['user__username']
    raw_id_fields = ['user']


@admin.register(SubscriptionPayment)
class SubscriptionPaymentAdmin(admin.ModelAdmin):
    list_display = ['user', 'months', 'amount', 'status', 'payment_method', 'reference', 'created_at', 'paid_at']
    list_filter = ['status', 'months']
    search_fields = ['user__username', 'reference']
    raw_id_fields = ['user']
    readonly_fields = ['raw']
