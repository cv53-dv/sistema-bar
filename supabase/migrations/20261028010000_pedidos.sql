-- =====================================================================
-- Demo Bar — Pedidos, comandas, stock y caja
-- Requiere la migración anterior (20261028000000_schema.sql).
--
-- Regla general: las tablas de pedidos/cuentas/caja NO se escriben
-- directamente desde la app. Todo pasa por funciones (RPC) que validan
-- el rol, toman los precios de la base de datos y descuentan el stock
-- dentro de una misma transacción.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. PERSONAL Y ROLES (reemplaza a la tabla admins)
-- ---------------------------------------------------------------------

create table if not exists public.personal (
    user_id    uuid primary key references auth.users (id) on delete cascade,
    rol        text not null check (rol in ('admin', 'mozo')),
    created_at timestamptz not null default now()
);

alter table public.personal enable row level security;

do $$
begin
    if to_regclass('public.admins') is not null then
        insert into public.personal (user_id, rol)
        select user_id, 'admin' from public.admins
        on conflict do nothing;
    end if;
end $$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from public.personal
        where user_id = (select auth.uid()) and rol = 'admin'
    );
$$;

-- Admin o mozo
create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = ''
as $$
    select exists (select 1 from public.personal where user_id = (select auth.uid()));
$$;

-- Rol del usuario actual ('admin', 'mozo' o null). Lo usa la app para redirigir.
create or replace function public.mi_rol()
returns text
language sql stable security definer set search_path = ''
as $$
    select rol from public.personal where user_id = (select auth.uid());
$$;

drop table if exists public.admins;

revoke execute on function public.is_staff(), public.mi_rol() from public, anon;
grant  execute on function public.is_staff(), public.mi_rol() to authenticated;


-- ---------------------------------------------------------------------
-- 2. STOCK EN PRODUCTOS
-- stock = null → el producto no lleva control de stock (ej. un cóctel)
-- ---------------------------------------------------------------------

alter table public.productos
    add column if not exists stock integer check (stock >= 0);

-- Al llegar a 0 se marca agotado; al reponer se vuelve a habilitar
create or replace function public.sincronizar_estado_stock()
returns trigger
language plpgsql set search_path = ''
as $$
begin
    if new.stock is not null and (tg_op = 'INSERT' or new.stock is distinct from old.stock) then
        if new.stock = 0 then
            new.estado := 'agotado';
        elsif tg_op = 'UPDATE' and coalesce(old.stock, 0) = 0 and old.estado = 'agotado' then
            new.estado := 'disponible';
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists productos_estado_stock on public.productos;
create trigger productos_estado_stock
    before insert or update of stock on public.productos
    for each row execute function public.sincronizar_estado_stock();


-- ---------------------------------------------------------------------
-- 3. TABLAS
-- ---------------------------------------------------------------------

-- El token va en el QR de la mesa: sin él un cliente no puede pedir
create table if not exists public.mesas (
    id         bigint generated always as identity primary key,
    nombre     text not null unique check (char_length(nombre) between 1 and 30),
    token      uuid not null unique default gen_random_uuid(),
    activa     boolean not null default true,
    created_at timestamptz not null default now()
);

create table if not exists public.cierres_caja (
    id                  bigint generated always as identity primary key,
    desde               timestamptz,
    hasta               timestamptz not null default now(),
    cuentas             integer not null default 0,
    total_efectivo      numeric(12,2) not null default 0,
    total_tarjeta       numeric(12,2) not null default 0,
    total_transferencia numeric(12,2) not null default 0,
    total               numeric(12,2) not null default 0,
    cerrado_por         uuid references auth.users (id),
    created_at          timestamptz not null default now()
);

-- Cuenta de una mesa: se abre con el primer pedido y se cierra al cobrar
create table if not exists public.cuentas (
    id          bigint generated always as identity primary key,
    mesa_id     bigint not null references public.mesas (id),
    estado      text not null default 'abierta' check (estado in ('abierta', 'cerrada', 'anulada')),
    metodo_pago text check (metodo_pago in ('efectivo', 'tarjeta', 'transferencia')),
    total       numeric(12,2),
    abierta_at  timestamptz not null default now(),
    cerrada_at  timestamptz,
    cerrada_por uuid references auth.users (id),
    cierre_id   bigint references public.cierres_caja (id)
);

-- Solo una cuenta abierta por mesa
create unique index if not exists cuentas_una_abierta_por_mesa
    on public.cuentas (mesa_id) where estado = 'abierta';
create index if not exists cuentas_turno_idx on public.cuentas (estado, cierre_id);

create table if not exists public.pedidos (
    id             bigint generated always as identity primary key,
    cuenta_id      bigint not null references public.cuentas (id),
    mesa_id        bigint not null references public.mesas (id),
    origen         text not null check (origen in ('mozo', 'cliente')),
    estado         text not null default 'pendiente'
                   check (estado in ('pendiente', 'confirmado', 'cancelado')),
    nota           text check (char_length(nota) <= 300),
    creado_por     uuid references auth.users (id),   -- null si lo hizo un cliente por QR
    confirmado_por uuid references auth.users (id),
    created_at     timestamptz not null default now(),
    confirmado_at  timestamptz,
    impreso_at     timestamptz
);

create index if not exists pedidos_cuenta_idx on public.pedidos (cuenta_id);
create index if not exists pedidos_comandas_idx on public.pedidos (estado, confirmado_at desc);

-- Nombre y precio se copian al momento del pedido (si luego cambia el precio, la cuenta no cambia)
create table if not exists public.pedido_items (
    id              bigint generated always as identity primary key,
    pedido_id       bigint not null references public.pedidos (id) on delete cascade,
    producto_id     bigint not null references public.productos (id),
    nombre          text not null,
    precio_unitario numeric(10,2) not null,
    cantidad        integer not null check (cantidad between 1 and 50),
    nota            text check (char_length(nota) <= 120)
);

create index if not exists pedido_items_pedido_idx on public.pedido_items (pedido_id);


-- ---------------------------------------------------------------------
-- 4. RLS — lectura para el personal, escritura solo vía funciones
-- ---------------------------------------------------------------------

alter table public.mesas        enable row level security;
alter table public.cuentas      enable row level security;
alter table public.pedidos      enable row level security;
alter table public.pedido_items enable row level security;
alter table public.cierres_caja enable row level security;

drop policy if exists "personal: admin lee" on public.personal;
create policy "personal: admin lee" on public.personal
    for select to authenticated using ((select public.is_admin()));

drop policy if exists "mesas: personal lee" on public.mesas;
create policy "mesas: personal lee" on public.mesas
    for select to authenticated using ((select public.is_staff()));

drop policy if exists "mesas: admin inserta" on public.mesas;
create policy "mesas: admin inserta" on public.mesas
    for insert to authenticated with check ((select public.is_admin()));

drop policy if exists "mesas: admin actualiza" on public.mesas;
create policy "mesas: admin actualiza" on public.mesas
    for update to authenticated
    using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "cuentas: personal lee" on public.cuentas;
create policy "cuentas: personal lee" on public.cuentas
    for select to authenticated using ((select public.is_staff()));

drop policy if exists "pedidos: personal lee" on public.pedidos;
create policy "pedidos: personal lee" on public.pedidos
    for select to authenticated using ((select public.is_staff()));

drop policy if exists "pedido_items: personal lee" on public.pedido_items;
create policy "pedido_items: personal lee" on public.pedido_items
    for select to authenticated using ((select public.is_staff()));

drop policy if exists "cierres: admin lee" on public.cierres_caja;
create policy "cierres: admin lee" on public.cierres_caja
    for select to authenticated using ((select public.is_admin()));


-- ---------------------------------------------------------------------
-- 5. FUNCIONES INTERNAS (esquema privado, no expuesto por la API)
-- ---------------------------------------------------------------------

create schema if not exists privado;
revoke all on schema privado from public, anon, authenticated;

create or replace function privado.insertar_pedido(
    p_mesa_id bigint, p_origen text, p_estado text, p_items jsonb, p_nota text
)
returns bigint
language plpgsql set search_path = ''
as $$
declare
    v_cuenta bigint;
    v_pedido bigint;
    v_item   jsonb;
    v_prod   record;
begin
    if not exists (select 1 from public.mesas where id = p_mesa_id and activa) then
        raise exception 'Mesa no válida';
    end if;
    if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
        raise exception 'El pedido está vacío';
    end if;
    if jsonb_array_length(p_items) > 30 then
        raise exception 'Demasiados productos en un solo pedido';
    end if;

    -- Abre la cuenta de la mesa si no hay una abierta
    insert into public.cuentas (mesa_id) values (p_mesa_id)
        on conflict (mesa_id) where estado = 'abierta' do nothing;
    select id into v_cuenta from public.cuentas where mesa_id = p_mesa_id and estado = 'abierta';

    insert into public.pedidos (cuenta_id, mesa_id, origen, estado, nota, creado_por)
    values (v_cuenta, p_mesa_id, p_origen, p_estado,
            nullif(left(trim(p_nota), 300), ''),
            (select auth.uid()))
    returning id into v_pedido;

    for v_item in select * from jsonb_array_elements(p_items) loop
        select id, nombre, precio into v_prod
        from public.productos
        where id = (v_item->>'producto_id')::bigint and activo and estado = 'disponible';

        if not found then
            raise exception 'Un producto del pedido ya no está disponible. Actualiza la carta.';
        end if;

        insert into public.pedido_items (pedido_id, producto_id, nombre, precio_unitario, cantidad, nota)
        values (v_pedido, v_prod.id, v_prod.nombre, v_prod.precio,
                (v_item->>'cantidad')::int,
                nullif(left(trim(v_item->>'nota'), 120), ''));
    end loop;

    return v_pedido;
end;
$$;

-- Descuenta el stock de un pedido. Si falta stock de algo, falla todo el pedido.
create or replace function privado.descontar_stock(p_pedido_id bigint)
returns void
language plpgsql set search_path = ''
as $$
declare
    r          record;
    v_quedan   integer;
begin
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
end;
$$;

create or replace function privado.reponer_stock_pedido(p_pedido_id bigint)
returns void
language sql set search_path = ''
as $$
    update public.productos p set stock = p.stock + i.cantidad
    from (
        select producto_id, sum(cantidad)::int as cantidad
        from public.pedido_items where pedido_id = p_pedido_id
        group by producto_id
    ) i
    where p.id = i.producto_id and p.stock is not null;
$$;


-- ---------------------------------------------------------------------
-- 6. FUNCIONES PÚBLICAS (RPC)
-- ---------------------------------------------------------------------

-- Cliente por QR: muestra el nombre de la mesa
create or replace function public.mesa_por_token(p_token uuid)
returns text
language sql stable security definer set search_path = ''
as $$
    select nombre from public.mesas where token = p_token and activa;
$$;

-- Cliente por QR: el pedido queda PENDIENTE hasta que lo confirme un mozo
create or replace function public.crear_pedido_cliente(p_mesa_token uuid, p_items jsonb, p_nota text default null)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
    v_mesa bigint;
begin
    select id into v_mesa from public.mesas where token = p_mesa_token and activa;
    if v_mesa is null then
        raise exception 'Mesa no válida. Vuelve a escanear el código QR.';
    end if;

    -- Freno básico contra pedidos repetidos o falsos
    if (select count(*) from public.pedidos where mesa_id = v_mesa and estado = 'pendiente') >= 3 then
        raise exception 'Ya hay pedidos de esta mesa esperando al mozo. Espera a que los confirme.';
    end if;

    return privado.insertar_pedido(v_mesa, 'cliente', 'pendiente', p_items, p_nota);
end;
$$;

-- Mozo: el pedido entra CONFIRMADO y descuenta stock en el acto
create or replace function public.crear_pedido_mozo(p_mesa_id bigint, p_items jsonb, p_nota text default null)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
    v_pedido bigint;
begin
    if not public.is_staff() then raise exception 'No autorizado'; end if;

    v_pedido := privado.insertar_pedido(p_mesa_id, 'mozo', 'confirmado', p_items, p_nota);
    update public.pedidos
        set confirmado_por = (select auth.uid()), confirmado_at = now()
        where id = v_pedido;
    perform privado.descontar_stock(v_pedido);
    return v_pedido;
end;
$$;

create or replace function public.confirmar_pedido(p_pedido_id bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
    if not public.is_staff() then raise exception 'No autorizado'; end if;

    update public.pedidos
        set estado = 'confirmado', confirmado_por = (select auth.uid()), confirmado_at = now()
        where id = p_pedido_id and estado = 'pendiente';
    if not found then
        raise exception 'El pedido ya fue confirmado o rechazado';
    end if;

    perform privado.descontar_stock(p_pedido_id);
end;
$$;

-- Mozo: rechaza pedidos pendientes. Anular uno ya confirmado (devuelve el stock) es solo para admin.
create or replace function public.cancelar_pedido(p_pedido_id bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_estado        text;
    v_estado_cuenta text;
begin
    if not public.is_staff() then raise exception 'No autorizado'; end if;

    select p.estado, c.estado into v_estado, v_estado_cuenta
    from public.pedidos p join public.cuentas c on c.id = p.cuenta_id
    where p.id = p_pedido_id
    for update of p;

    if v_estado is null then raise exception 'Pedido no encontrado'; end if;
    if v_estado = 'cancelado' then raise exception 'El pedido ya estaba cancelado'; end if;
    if v_estado_cuenta <> 'abierta' then raise exception 'La cuenta ya está cerrada'; end if;
    if v_estado = 'confirmado' and not public.is_admin() then
        raise exception 'Solo un administrador puede anular un pedido ya confirmado';
    end if;

    if v_estado = 'confirmado' then
        perform privado.reponer_stock_pedido(p_pedido_id);
    end if;
    update public.pedidos set estado = 'cancelado' where id = p_pedido_id;
end;
$$;

-- Estación de comandas: reserva el pedido para imprimir.
-- Devuelve false si otro equipo ya lo imprimió (evita tickets duplicados).
create or replace function public.marcar_impreso(p_pedido_id bigint)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
    if not public.is_staff() then raise exception 'No autorizado'; end if;

    update public.pedidos set impreso_at = now()
        where id = p_pedido_id and estado = 'confirmado' and impreso_at is null;
    return found;
end;
$$;

-- Cobra la cuenta de una mesa. El total se calcula aquí, no en el navegador.
create or replace function public.cerrar_cuenta(p_cuenta_id bigint, p_metodo text)
returns numeric
language plpgsql security definer set search_path = ''
as $$
declare
    v_total numeric(12,2);
begin
    if not public.is_staff() then raise exception 'No autorizado'; end if;

    perform 1 from public.cuentas where id = p_cuenta_id and estado = 'abierta' for update;
    if not found then raise exception 'La cuenta no existe o ya fue cerrada'; end if;

    if exists (select 1 from public.pedidos where cuenta_id = p_cuenta_id and estado = 'pendiente') then
        raise exception 'Hay pedidos sin confirmar en esta mesa. Confírmalos o recházalos antes de cobrar.';
    end if;

    select coalesce(sum(i.precio_unitario * i.cantidad), 0) into v_total
    from public.pedido_items i
    join public.pedidos p on p.id = i.pedido_id
    where p.cuenta_id = p_cuenta_id and p.estado = 'confirmado';

    -- Mesa sin consumo (todo rechazado/anulado): se libera sin cobrar
    if v_total = 0 then
        update public.cuentas
            set estado = 'anulada', total = 0, cerrada_at = now(), cerrada_por = (select auth.uid())
            where id = p_cuenta_id;
        return 0;
    end if;

    if p_metodo is null or p_metodo not in ('efectivo', 'tarjeta', 'transferencia') then
        raise exception 'Método de pago no válido';
    end if;

    update public.cuentas
        set estado = 'cerrada', metodo_pago = p_metodo, total = v_total,
            cerrada_at = now(), cerrada_por = (select auth.uid())
        where id = p_cuenta_id;
    return v_total;
end;
$$;

-- Resumen de ventas: del turno actual (p_cierre_id null) o de un cierre pasado
create or replace function public.resumen_ventas(p_cierre_id bigint default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
    v_resultado jsonb;
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;

    with cuentas_turno as (
        select * from public.cuentas
        where estado = 'cerrada'
          and cierre_id is not distinct from p_cierre_id
    ),
    productos_turno as (
        select i.nombre, sum(i.cantidad)::int as cantidad, sum(i.cantidad * i.precio_unitario) as total
        from public.pedido_items i
        join public.pedidos p on p.id = i.pedido_id and p.estado = 'confirmado'
        join cuentas_turno c on c.id = p.cuenta_id
        group by i.nombre
    )
    select jsonb_build_object(
        'desde',   (select min(cerrada_at) from cuentas_turno),
        'hasta',   (select max(cerrada_at) from cuentas_turno),
        'cuentas', (select count(*) from cuentas_turno),
        'total',   (select coalesce(sum(total), 0) from cuentas_turno),
        'por_metodo', jsonb_build_object(
            'efectivo',      (select coalesce(sum(total), 0) from cuentas_turno where metodo_pago = 'efectivo'),
            'tarjeta',       (select coalesce(sum(total), 0) from cuentas_turno where metodo_pago = 'tarjeta'),
            'transferencia', (select coalesce(sum(total), 0) from cuentas_turno where metodo_pago = 'transferencia')
        ),
        'productos', coalesce(
            (select jsonb_agg(to_jsonb(pt) order by pt.cantidad desc, pt.nombre) from productos_turno pt),
            '[]'::jsonb)
    ) into v_resultado;

    return v_resultado;
end;
$$;

-- Cierre de caja: agrupa todas las cuentas cobradas desde el cierre anterior
create or replace function public.cierre_caja()
returns public.cierres_caja
language plpgsql security definer set search_path = ''
as $$
declare
    v_cierre public.cierres_caja;
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;

    insert into public.cierres_caja (cerrado_por) values ((select auth.uid()))
        returning * into v_cierre;

    update public.cuentas set cierre_id = v_cierre.id
        where estado = 'cerrada' and cierre_id is null;
    if not found then
        raise exception 'No hay ventas cobradas desde el último cierre';
    end if;

    update public.cierres_caja c set
        desde               = t.desde,
        cuentas             = t.cuentas,
        total_efectivo      = t.efectivo,
        total_tarjeta       = t.tarjeta,
        total_transferencia = t.transferencia,
        total               = t.total
    from (
        select min(cerrada_at) as desde, count(*) as cuentas,
               coalesce(sum(total) filter (where metodo_pago = 'efectivo'), 0)      as efectivo,
               coalesce(sum(total) filter (where metodo_pago = 'tarjeta'), 0)       as tarjeta,
               coalesce(sum(total) filter (where metodo_pago = 'transferencia'), 0) as transferencia,
               coalesce(sum(total), 0) as total
        from public.cuentas where cierre_id = v_cierre.id
    ) t
    where c.id = v_cierre.id
    returning c.* into v_cierre;

    return v_cierre;
end;
$$;

-- Ingreso de mercadería: suma unidades de forma atómica
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

    update public.productos set stock = coalesce(stock, 0) + p_cantidad
        where id = p_producto_id
        returning stock into v_stock;
    if not found then raise exception 'Producto no encontrado'; end if;
    return v_stock;
end;
$$;

-- Personal: listar, asignar rol a un usuario ya creado en Supabase Auth, y quitarlo
create or replace function public.listar_personal()
returns table (user_id uuid, email text, rol text)
language plpgsql stable security definer set search_path = ''
as $$
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;
    return query
        select p.user_id, u.email::text, p.rol
        from public.personal p join auth.users u on u.id = p.user_id
        order by p.rol, u.email;
end;
$$;

create or replace function public.asignar_rol(p_email text, p_rol text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_user uuid;
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;
    if p_rol not in ('admin', 'mozo') then raise exception 'Rol no válido'; end if;

    select id into v_user from auth.users where lower(email) = lower(trim(p_email));
    if v_user is null then
        raise exception 'No existe un usuario con ese email. Créalo primero en Supabase → Authentication.';
    end if;
    if v_user = (select auth.uid()) and p_rol <> 'admin' then
        raise exception 'No puedes quitarte a ti mismo el rol de administrador';
    end if;

    insert into public.personal (user_id, rol) values (v_user, p_rol)
        on conflict (user_id) do update set rol = excluded.rol;
end;
$$;

create or replace function public.quitar_personal(p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;
    if p_user_id = (select auth.uid()) then
        raise exception 'No puedes quitarte acceso a ti mismo';
    end if;
    delete from public.personal where user_id = p_user_id;
end;
$$;

-- Permisos: Supabase da EXECUTE a anon por defecto; se restringe función por función
revoke execute on function
    public.mesa_por_token(uuid),
    public.crear_pedido_cliente(uuid, jsonb, text),
    public.crear_pedido_mozo(bigint, jsonb, text),
    public.confirmar_pedido(bigint),
    public.cancelar_pedido(bigint),
    public.marcar_impreso(bigint),
    public.cerrar_cuenta(bigint, text),
    public.resumen_ventas(bigint),
    public.cierre_caja(),
    public.reponer_stock(bigint, integer),
    public.listar_personal(),
    public.asignar_rol(text, text),
    public.quitar_personal(uuid),
    public.sincronizar_estado_stock()
from public, anon, authenticated;

grant execute on function
    public.mesa_por_token(uuid),
    public.crear_pedido_cliente(uuid, jsonb, text)
to anon, authenticated;

grant execute on function
    public.crear_pedido_mozo(bigint, jsonb, text),
    public.confirmar_pedido(bigint),
    public.cancelar_pedido(bigint),
    public.marcar_impreso(bigint),
    public.cerrar_cuenta(bigint, text),
    public.resumen_ventas(bigint),
    public.cierre_caja(),
    public.reponer_stock(bigint, integer),
    public.listar_personal(),
    public.asignar_rol(text, text),
    public.quitar_personal(uuid)
to authenticated;


-- ---------------------------------------------------------------------
-- 7. TIEMPO REAL (pantalla de comandas y mozos)
-- ---------------------------------------------------------------------

do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        if not exists (select 1 from pg_publication_tables
                       where pubname = 'supabase_realtime' and tablename = 'pedidos') then
            alter publication supabase_realtime add table public.pedidos;
        end if;
        if not exists (select 1 from pg_publication_tables
                       where pubname = 'supabase_realtime' and tablename = 'cuentas') then
            alter publication supabase_realtime add table public.cuentas;
        end if;
    end if;
end $$;


-- ---------------------------------------------------------------------
-- 8. ALTA DEL PERSONAL
--    a) Supabase → Authentication → Users → "Add user"
--    b) Desde la app: Caja → Personal → email + rol
--       (el primer admin se crea aquí, desde el SQL Editor):
-- ---------------------------------------------------------------------
-- insert into public.personal (user_id, rol)
-- select id, 'admin' from auth.users where email = 'admin@tubar.com'
-- on conflict (user_id) do update set rol = 'admin';
