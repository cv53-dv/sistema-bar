-- =====================================================================
-- Demo Bar — Movimientos de stock e informes
-- Cada cambio de productos.stock deja un movimiento (venta, anulación,
-- ingreso o ajuste) con quién, cuándo y cuánto quedó. Un solo trigger
-- cubre todas las vías, incluso una edición directa.
-- Informes: inventario actual y movimientos por rango de fecha y hora.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. TABLA (inmutable, solo la escribe el trigger)
-- ---------------------------------------------------------------------

create table if not exists public.stock_movimientos (
    id              bigint generated always as identity primary key,
    at              timestamptz not null default now(),
    producto_id     bigint not null references public.productos (id),
    tipo            text not null check (tipo in ('venta', 'anulacion', 'ingreso', 'ajuste')),
    cantidad        integer not null,           -- con signo: venta -2, ingreso +10
    stock_resultante integer,                   -- null: se quitó el control de stock
    pedido_id       bigint,
    user_id         uuid,
    motivo          text
);

create index if not exists stock_mov_at_idx       on public.stock_movimientos (at desc);
create index if not exists stock_mov_producto_idx on public.stock_movimientos (producto_id, at desc);

alter table public.stock_movimientos enable row level security;   -- sin políticas
revoke all on public.stock_movimientos from public, anon, authenticated;

drop trigger if exists stock_mov_sin_cambios on public.stock_movimientos;
create trigger stock_mov_sin_cambios
    before update or delete on public.stock_movimientos
    for each row execute function privado.auditoria_inmutable();

drop trigger if exists stock_mov_sin_truncate on public.stock_movimientos;
create trigger stock_mov_sin_truncate
    before truncate on public.stock_movimientos
    for each statement execute function privado.auditoria_inmutable();


-- ---------------------------------------------------------------------
-- 2. TRIGGER
-- El tipo, el pedido y el motivo llegan por variables de la transacción
-- (set_config local) que fijan las funciones de venta, anulación,
-- ingreso y ajuste. Sin ellas, el cambio queda como 'ajuste'.
-- ---------------------------------------------------------------------

create or replace function privado.fijar_contexto_stock(p_tipo text, p_pedido bigint, p_motivo text)
returns void
language sql set search_path = ''
as $$
    select set_config('app.stock_tipo',   coalesce(p_tipo, ''), true),
           set_config('app.stock_pedido', coalesce(p_pedido::text, ''), true),
           set_config('app.stock_motivo', coalesce(p_motivo, ''), true);
$$;

create or replace function privado.registrar_movimiento_stock()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
    v_antes    integer := case when tg_op = 'UPDATE' then old.stock end;
    v_tipo     text    := coalesce(nullif(current_setting('app.stock_tipo', true), ''), 'ajuste');
    v_pedido   text    := nullif(current_setting('app.stock_pedido', true), '');
    v_motivo   text    := nullif(current_setting('app.stock_motivo', true), '');
begin
    if tg_op = 'INSERT' then
        if new.stock is null then return new; end if;
        v_motivo := coalesce(v_motivo, 'Stock inicial');
    elsif new.stock is not distinct from old.stock then
        return new;
    elsif new.stock is null then
        v_motivo := coalesce(v_motivo, 'Se quitó el control de stock');
    end if;

    insert into public.stock_movimientos
        (producto_id, tipo, cantidad, stock_resultante, pedido_id, user_id, motivo)
    values (
        new.id, v_tipo, coalesce(new.stock, 0) - coalesce(v_antes, 0), new.stock,
        v_pedido::bigint, (select auth.uid()), v_motivo
    );
    return new;
end;
$$;

drop trigger if exists productos_movimiento_stock on public.productos;
create trigger productos_movimiento_stock
    after insert or update of stock on public.productos
    for each row execute function privado.registrar_movimiento_stock();


-- ---------------------------------------------------------------------
-- 3. LAS CUATRO VÍAS QUE TOCAN EL STOCK
-- ---------------------------------------------------------------------

create or replace function privado.descontar_stock(p_pedido_id bigint)
returns void
language plpgsql set search_path = ''
as $$
declare
    r          record;
    v_quedan   integer;
begin
    perform privado.fijar_contexto_stock('venta', p_pedido_id, null);
    for r in
        select producto_id, sum(cantidad)::int as cantidad, min(nombre) as nombre
        from public.pedido_items where pedido_id = p_pedido_id
        group by producto_id
    loop
        update public.productos set stock = stock - r.cantidad
        where id = r.producto_id and stock is not null and stock >= r.cantidad;

        if not found then
            select stock into v_quedan from public.productos where id = r.producto_id;
            if v_quedan is not null then
                raise exception 'Stock insuficiente de "%": quedan %', r.nombre, v_quedan;
            end if;
        end if;
    end loop;
    perform privado.fijar_contexto_stock(null, null, null);
end;
$$;

create or replace function privado.reponer_stock_pedido(p_pedido_id bigint)
returns void
language plpgsql set search_path = ''
as $$
begin
    perform privado.fijar_contexto_stock('anulacion', p_pedido_id, null);
    update public.productos p set stock = p.stock + i.cantidad
    from (
        select producto_id, sum(cantidad)::int as cantidad
        from public.pedido_items where pedido_id = p_pedido_id
        group by producto_id
    ) i
    where p.id = i.producto_id and p.stock is not null;
    perform privado.fijar_contexto_stock(null, null, null);
end;
$$;

create or replace function public.reponer_stock(p_producto_id bigint, p_cantidad integer)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
    v_stock integer;
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;
    if p_cantidad is null or p_cantidad <= 0 or p_cantidad > 10000 then
        raise exception 'Cantidad no válida';
    end if;

    perform privado.fijar_contexto_stock('ingreso', null, 'Ingreso de mercadería');
    update public.productos set stock = coalesce(stock, 0) + p_cantidad
        where id = p_producto_id
        returning stock into v_stock;
    perform privado.fijar_contexto_stock(null, null, null);
    if v_stock is null then raise exception 'Producto no encontrado'; end if;   -- PERFORM pisa FOUND
    return v_stock;
end;
$$;

-- Corrección manual (conteo físico, rotura, merma): exige motivo
create or replace function public.ajustar_stock(p_producto_id bigint, p_nuevo_stock integer, p_motivo text)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
    v_motivo text := nullif(trim(p_motivo), '');
    v_stock  integer;
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;
    if p_nuevo_stock is null or p_nuevo_stock < 0 or p_nuevo_stock > 1000000 then
        raise exception 'Stock no válido';
    end if;
    if v_motivo is null or char_length(v_motivo) < 3 then
        raise exception 'Indica el motivo del ajuste';
    end if;

    perform privado.fijar_contexto_stock('ajuste', null, left(v_motivo, 200));
    update public.productos set stock = p_nuevo_stock
        where id = p_producto_id
        returning stock into v_stock;
    perform privado.fijar_contexto_stock(null, null, null);
    if v_stock is null then raise exception 'Producto no encontrado'; end if;   -- PERFORM pisa FOUND
    return v_stock;
end;
$$;


-- ---------------------------------------------------------------------
-- 4. INFORMES
-- ---------------------------------------------------------------------

-- Inventario actual: stock null = el producto no lleva control
create or replace function public.inventario_actual()
returns table (id bigint, nombre text, categoria text, stock integer, estado text)
language plpgsql stable security definer set search_path = ''
as $$
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;
    return query
        select p.id, p.nombre, coalesce(c.nombre, '—'), p.stock, p.estado
        from public.productos p
        left join public.categorias c on c.id = p.categoria_id
        where p.activo
        order by (p.stock is null), coalesce(c.orden, 9999), p.nombre;
end;
$$;

-- Movimientos en un rango de fecha y hora (hasta el minuto)
create or replace function public.movimientos_stock(
    p_desde timestamptz default null,
    p_hasta timestamptz default null,
    p_producto bigint default null,
    p_tipo text default null,
    p_limite integer default 1000
)
returns table (
    id bigint, at timestamptz, producto text, tipo text, cantidad integer,
    stock_resultante integer, pedido_id bigint, email text, motivo text
)
language plpgsql stable security definer set search_path = ''
as $$
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;
    return query
        select m.id, m.at, p.nombre, m.tipo, m.cantidad, m.stock_resultante, m.pedido_id,
               u.email::text, m.motivo
        from public.stock_movimientos m
        join public.productos p on p.id = m.producto_id
        left join auth.users u on u.id = m.user_id
        where (p_desde    is null or m.at >= p_desde)
          and (p_hasta    is null or m.at <= p_hasta)
          and (p_producto is null or m.producto_id = p_producto)
          and (p_tipo     is null or m.tipo = p_tipo)
        order by m.at desc, m.id desc
        limit least(greatest(coalesce(p_limite, 1000), 1), 5000);
end;
$$;


-- ---------------------------------------------------------------------
-- 5. PERMISOS
-- ---------------------------------------------------------------------

revoke execute on function
    public.ajustar_stock(bigint, integer, text),
    public.inventario_actual(),
    public.movimientos_stock(timestamptz, timestamptz, bigint, text, integer),
    public.reponer_stock(bigint, integer)
from public, anon, authenticated;

grant execute on function
    public.ajustar_stock(bigint, integer, text),
    public.inventario_actual(),
    public.movimientos_stock(timestamptz, timestamptz, bigint, text, integer),
    public.reponer_stock(bigint, integer)
to authenticated;

revoke all on function privado.fijar_contexto_stock(text, bigint, text) from public, anon, authenticated;
