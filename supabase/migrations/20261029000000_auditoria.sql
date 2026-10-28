-- =====================================================================
-- Demo Bar — Auditoría
-- Todo cambio en las tablas del negocio queda registrado (quién, cuándo,
-- valor anterior y nuevo). El registro no se puede modificar ni borrar.
-- Los rollbacks (anular un pedido ya confirmado) exigen un motivo.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. TABLA (solo se escribe desde triggers y funciones; nadie la toca por la API)
-- ---------------------------------------------------------------------

create table if not exists public.auditoria (
    id          bigint generated always as identity primary key,
    at          timestamptz not null default now(),
    user_id     uuid,                       -- null: cliente por QR o proceso interno
    accion      text not null check (accion in ('insert', 'update', 'delete', 'rollback')),
    tabla       text not null,
    registro_id text,
    antes       jsonb,
    despues     jsonb,
    motivo      text
);

create index if not exists auditoria_at_idx    on public.auditoria (at desc);
create index if not exists auditoria_tabla_idx on public.auditoria (tabla, at desc);

alter table public.auditoria enable row level security;   -- sin políticas: la API no la ve
revoke all on public.auditoria from public, anon, authenticated;

-- Inmutable: ni update ni delete ni truncate, ni siquiera desde una función
create or replace function privado.auditoria_inmutable()
returns trigger
language plpgsql set search_path = ''
as $$
begin
    raise exception 'El registro de auditoría no se puede modificar ni borrar';
end;
$$;

drop trigger if exists auditoria_sin_cambios on public.auditoria;
create trigger auditoria_sin_cambios
    before update or delete on public.auditoria
    for each row execute function privado.auditoria_inmutable();

drop trigger if exists auditoria_sin_truncate on public.auditoria;
create trigger auditoria_sin_truncate
    before truncate on public.auditoria
    for each statement execute function privado.auditoria_inmutable();


-- ---------------------------------------------------------------------
-- 2. TRIGGER GENÉRICO
-- ---------------------------------------------------------------------

create or replace function privado.auditar()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
    v_antes   jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
    v_despues jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
    v_fila    jsonb := coalesce(v_despues, v_antes);
begin
    -- Un update que no cambia nada no es un hecho que auditar
    if tg_op = 'UPDATE' and v_antes = v_despues then return new; end if;

    insert into public.auditoria (user_id, accion, tabla, registro_id, antes, despues)
    values (
        (select auth.uid()), lower(tg_op), tg_table_name,
        coalesce(v_fila ->> 'id', v_fila ->> 'user_id'),
        v_antes, v_despues
    );
    return coalesce(new, old);
end;
$$;

do $$
declare
    t text;
begin
    foreach t in array array['productos', 'categorias', 'personal', 'mesas', 'cuentas',
                             'pedidos', 'pedido_items', 'cierres_caja', 'opiniones']
    loop
        execute format('drop trigger if exists auditar on public.%I', t);
        execute format(
            'create trigger auditar after insert or update or delete on public.%I
             for each row execute function privado.auditar()', t);
    end loop;
end $$;


-- ---------------------------------------------------------------------
-- 3. MENOS BORRADOS
-- Productos ya usa borrado lógico (activo = false): se quita el DELETE real.
-- Los pedidos no se pueden perder por arrastre de otra tabla.
-- Lo que aún se pueda borrar (categorías, personal, opiniones) queda
-- guardado completo en auditoría.
-- ---------------------------------------------------------------------

drop policy if exists "productos: admin elimina" on public.productos;

alter table public.pedido_items drop constraint if exists pedido_items_pedido_id_fkey;
alter table public.pedido_items
    add constraint pedido_items_pedido_id_fkey
    foreign key (pedido_id) references public.pedidos (id);


-- ---------------------------------------------------------------------
-- 4. ROLLBACK AUDITADO
-- Anular un pedido ya confirmado devuelve el stock: exige motivo y deja
-- una fila 'rollback' además del cambio de estado.
-- ---------------------------------------------------------------------

drop function if exists public.cancelar_pedido(bigint);

create or replace function public.cancelar_pedido(p_pedido_id bigint, p_motivo text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
    v_estado        text;
    v_estado_cuenta text;
    v_motivo        text := nullif(trim(p_motivo), '');
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
    if v_estado = 'confirmado' and (v_motivo is null or char_length(v_motivo) < 3) then
        raise exception 'Indica el motivo de la anulación';
    end if;

    if v_estado = 'confirmado' then
        perform privado.reponer_stock_pedido(p_pedido_id);
        insert into public.auditoria (user_id, accion, tabla, registro_id, antes, motivo)
        select (select auth.uid()), 'rollback', 'pedidos', p.id::text, to_jsonb(p), v_motivo
        from public.pedidos p where p.id = p_pedido_id;
    end if;
    update public.pedidos set estado = 'cancelado' where id = p_pedido_id;
end;
$$;

revoke execute on function public.cancelar_pedido(bigint, text) from public, anon, authenticated;
grant  execute on function public.cancelar_pedido(bigint, text) to authenticated;


-- ---------------------------------------------------------------------
-- 5. CONSULTA PARA EL ADMIN
-- ---------------------------------------------------------------------

create or replace function public.listar_auditoria(
    p_desde timestamptz default null,
    p_hasta timestamptz default null,
    p_tabla text default null,
    p_accion text default null,
    p_limite integer default 200
)
returns table (
    id bigint, at timestamptz, email text, accion text, tabla text,
    registro_id text, antes jsonb, despues jsonb, motivo text
)
language plpgsql stable security definer set search_path = ''
as $$
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;
    return query
        select a.id, a.at, u.email::text, a.accion, a.tabla, a.registro_id, a.antes, a.despues, a.motivo
        from public.auditoria a
        left join auth.users u on u.id = a.user_id
        where (p_desde  is null or a.at >= p_desde)
          and (p_hasta  is null or a.at <= p_hasta)
          and (p_tabla  is null or a.tabla  = p_tabla)
          and (p_accion is null or a.accion = p_accion)
        order by a.at desc, a.id desc
        limit least(greatest(coalesce(p_limite, 200), 1), 1000);
end;
$$;

revoke execute on function public.listar_auditoria(timestamptz, timestamptz, text, text, integer)
    from public, anon, authenticated;
grant  execute on function public.listar_auditoria(timestamptz, timestamptz, text, text, integer)
    to authenticated;
