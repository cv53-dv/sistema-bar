-- =====================================================================
-- Demo Bar — Precios en guaraníes (sin decimales)
-- Los montos con decimales se redondean al guaraní más cercano.
-- =====================================================================

alter table public.productos
    alter column precio type numeric(12,0) using round(precio);

alter table public.pedido_items
    alter column precio_unitario type numeric(12,0) using round(precio_unitario);

alter table public.cuentas
    alter column total type numeric(14,0) using round(total);

alter table public.cierres_caja
    alter column total_efectivo      type numeric(14,0) using round(total_efectivo),
    alter column total_tarjeta       type numeric(14,0) using round(total_tarjeta),
    alter column total_transferencia type numeric(14,0) using round(total_transferencia),
    alter column total               type numeric(14,0) using round(total);
