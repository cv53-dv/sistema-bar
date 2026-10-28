-- =====================================================================
-- Demo Bar — Categorías administrables
-- Reemplaza la lista fija de 7 categorías por una tabla que el admin
-- gestiona desde Productos. Los productos existentes se migran solos.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. TABLA
-- visible = false → la categoría y sus productos no aparecen en la carta
-- (el personal los sigue viendo y puede cargarlos en pedidos)
-- ---------------------------------------------------------------------

create table if not exists public.categorias (
    id         bigint generated always as identity primary key,
    nombre     text not null unique check (char_length(trim(nombre)) between 1 and 40),
    emoji      text not null default '' check (char_length(emoji) <= 8),
    orden      integer not null default 0,
    visible    boolean not null default true,
    created_at timestamptz not null default now()
);

-- "Cocteles", "cocteles" y " Cocteles " son la misma categoría
create unique index if not exists categorias_nombre_unico on public.categorias (lower(trim(nombre)));

alter table public.categorias enable row level security;

-- Dos políticas: el visitante (anon) no tiene permiso para ejecutar is_staff()
drop policy if exists "categorias: lectura" on public.categorias;
drop policy if exists "categorias: visitante lee visibles" on public.categorias;
create policy "categorias: visitante lee visibles" on public.categorias
    for select to anon
    using (visible);

drop policy if exists "categorias: usuario lee" on public.categorias;
create policy "categorias: usuario lee" on public.categorias
    for select to authenticated
    using (visible or (select public.is_staff()));

drop policy if exists "categorias: admin inserta" on public.categorias;
create policy "categorias: admin inserta" on public.categorias
    for insert to authenticated with check ((select public.is_admin()));

drop policy if exists "categorias: admin actualiza" on public.categorias;
create policy "categorias: admin actualiza" on public.categorias
    for update to authenticated
    using ((select public.is_admin())) with check ((select public.is_admin()));

-- Sin política de DELETE: se borra con eliminar_categoria(), que valida antes


-- ---------------------------------------------------------------------
-- 2. MIGRACIÓN DE LAS 7 CATEGORÍAS FIJAS
-- ---------------------------------------------------------------------

alter table public.productos
    add column if not exists categoria_id bigint references public.categorias (id) on delete set null;

do $$
begin
    -- Solo si todavía existe la columna de texto vieja
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'productos' and column_name = 'categoria') then

        insert into public.categorias (nombre, emoji, orden)
        values ('Cocteles', '🍸', 1), ('Cervezas', '🍺', 2), ('Vinos y licores', '🍷', 3),
               ('Sin alcohol', '🥤', 4), ('Pizzas y pastas', '🍕', 5), ('Platos fuertes', '🍖', 6),
               ('Para picar', '🍟', 7)
        on conflict (nombre) do nothing;

        update public.productos p set categoria_id = c.id
        from (values ('cocteles', 'Cocteles'), ('cervezas', 'Cervezas'), ('licores', 'Vinos y licores'),
                     ('bebidas_sin', 'Sin alcohol'), ('italiana', 'Pizzas y pastas'),
                     ('fuertes', 'Platos fuertes'), ('tapas', 'Para picar')) as m(clave, nombre)
        join public.categorias c on c.nombre = m.nombre
        where p.categoria = m.clave and p.categoria_id is null;

        alter table public.productos drop column categoria;
    end if;
end $$;

-- Un producto activo siempre tiene categoría (los eliminados pueden quedar sin ella)
alter table public.productos drop constraint if exists productos_activo_con_categoria;
alter table public.productos add constraint productos_activo_con_categoria
    check (not activo or categoria_id is not null);

create index if not exists productos_categoria_idx on public.productos (categoria_id);


-- ---------------------------------------------------------------------
-- 3. FUNCIONES
-- ---------------------------------------------------------------------

-- Reordena todas las categorías según la lista de ids recibida
create or replace function public.ordenar_categorias(p_ids bigint[])
returns void
language plpgsql security definer set search_path = ''
as $$
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;
    update public.categorias c set orden = o.posicion
    from unnest(p_ids) with ordinality as o(id, posicion)
    where c.id = o.id;
end;
$$;

-- Borra una categoría solo si no tiene productos en la carta
create or replace function public.eliminar_categoria(p_id bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_activos integer;
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;

    select count(*) into v_activos from public.productos where categoria_id = p_id and activo;
    if v_activos > 0 then
        raise exception 'La categoría tiene % producto(s). Muévelos a otra categoría antes de eliminarla.', v_activos;
    end if;

    delete from public.categorias where id = p_id;
    if not found then raise exception 'Categoría no encontrada'; end if;
end;
$$;

revoke execute on function public.ordenar_categorias(bigint[]), public.eliminar_categoria(bigint)
    from public, anon, authenticated;
grant execute on function public.ordenar_categorias(bigint[]), public.eliminar_categoria(bigint)
    to authenticated;

-- Pedidos: un cliente por QR no puede pedir productos de una categoría oculta
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
        select p.id, p.nombre, p.precio into v_prod
        from public.productos p
        join public.categorias c on c.id = p.categoria_id
        where p.id = (v_item->>'producto_id')::bigint
          and p.activo and p.estado = 'disponible'
          and (p_origen <> 'cliente' or c.visible);

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
