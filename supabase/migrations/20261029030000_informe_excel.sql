-- Corte consistente, exclusivo de administración, sin paginación silenciosa.
create or replace function public.informe_excel(p_desde date, p_hasta date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
    d timestamptz;
    h timestamptz;
    resultado jsonb;
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;
    if p_desde is null or p_hasta is null or p_desde > p_hasta
       or p_hasta - p_desde > 366 then
        raise exception 'Elegí un rango válido de hasta 367 días';
    end if;
    d := p_desde::timestamp at time zone 'America/Asuncion';
    h := (p_hasta + 1)::timestamp at time zone 'America/Asuncion';
    with ventas as (
        select c.id, c.cerrada_at, m.nombre as mesa, c.metodo_pago, c.total
        from public.cuentas c join public.mesas m on m.id = c.mesa_id
        where c.estado = 'cerrada' and c.cerrada_at >= d and c.cerrada_at < h
    ), items as (
        select p.cuenta_id, i.pedido_id, i.id, i.nombre, i.cantidad, i.precio_unitario
        from public.pedido_items i join public.pedidos p on p.id = i.pedido_id
        join ventas v on v.id = p.cuenta_id where p.estado = 'confirmado'
    ), caja as (
        select c.id,c.estado,c.abierta_at,c.desde,c.hasta,c.monto_inicial,c.cuentas,
            c.total_efectivo,c.total_tarjeta,c.total_transferencia,c.total,
            c.efectivo_esperado,c.efectivo_contado,c.diferencia
        from public.cierres_caja c where
            (c.estado = 'cerrada' and c.hasta >= d and c.hasta < h) or
            (c.estado = 'abierta' and c.abierta_at >= d and c.abierta_at < h)
    ), stock as (
        select s.id,s.at,p.nombre as producto,s.tipo,s.cantidad,s.stock_resultante,s.pedido_id,s.motivo
        from public.stock_movimientos s join public.productos p on p.id=s.producto_id
        where s.at >= d and s.at < h
    ), inventario as (
        select p.id,p.nombre,c.nombre as categoria,p.stock,p.estado,p.activo
        from public.productos p left join public.categorias c on c.id=p.categoria_id
    )
    select jsonb_build_object('generado',now(),
        'ventas',coalesce((select jsonb_agg(to_jsonb(v) order by v.cerrada_at,v.id) from ventas v),'[]'::jsonb),
        'items',coalesce((select jsonb_agg(to_jsonb(i) order by i.cuenta_id,i.pedido_id,i.id) from items i),'[]'::jsonb),
        'caja',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from caja c),'[]'::jsonb),
        'stock',coalesce((select jsonb_agg(to_jsonb(s) order by s.at,s.id) from stock s),'[]'::jsonb),
        'inventario',coalesce((select jsonb_agg(to_jsonb(p) order by p.nombre,p.id) from inventario p),'[]'::jsonb))
    into resultado;
    if greatest(jsonb_array_length(resultado->'ventas'),jsonb_array_length(resultado->'items'),
        jsonb_array_length(resultado->'stock'),jsonb_array_length(resultado->'caja'),
        jsonb_array_length(resultado->'inventario')) > 100000 then
        raise exception 'Informe demasiado grande; reducí el rango de fechas';
    end if;
    return resultado;
end;
$$;
revoke all on function public.informe_excel(date,date) from public,anon,authenticated;
grant execute on function public.informe_excel(date,date) to authenticated;
