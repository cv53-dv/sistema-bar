-- =====================================================================
-- Demo Bar — Caja con apertura, bloqueo de ventas y arqueo
-- La caja se abre con un monto inicial (el cambio para vueltos). Sin caja
-- abierta no se pide, confirma ni cobra nada. Al cerrar se cuenta el
-- efectivo (arqueo) y se guarda la diferencia contra lo esperado.
-- Un turno = una fila de cierres_caja.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. TURNO
-- Los cierres existentes quedan como 'cerrada'.
-- ---------------------------------------------------------------------

alter table public.cierres_caja
    add column if not exists estado           text not null default 'cerrada'
                                              check (estado in ('abierta', 'cerrada')),
    add column if not exists abierta_at       timestamptz,
    add column if not exists abierta_por      uuid references auth.users (id),
    add column if not exists monto_inicial    numeric(14,0) not null default 0 check (monto_inicial >= 0),
    add column if not exists efectivo_esperado numeric(14,0),
    add column if not exists efectivo_contado numeric(14,0) check (efectivo_contado >= 0),
    add column if not exists diferencia       numeric(14,0);

-- Mientras el turno está abierto, "hasta" aún no existe
alter table public.cierres_caja alter column hasta drop not null;
alter table public.cierres_caja alter column hasta drop default;

-- Un solo turno abierto a la vez
create unique index if not exists cierres_un_turno_abierto
    on public.cierres_caja ((true)) where estado = 'abierta';


-- ---------------------------------------------------------------------
-- 2. BLOQUEO: sin turno abierto no se vende
-- Se hace con triggers para cubrir todos los caminos (cliente QR, mozo,
-- confirmar, cobrar) sin reescribir cada función.
-- ---------------------------------------------------------------------

create or replace function privado.exigir_caja_abierta()
returns trigger
language plpgsql set search_path = ''
as $$
begin
    if not exists (select 1 from public.cierres_caja where estado = 'abierta') then
        raise exception 'La caja está cerrada. Abre la caja para vender.';
    end if;
    return new;
end;
$$;

-- Pedido nuevo (cliente o mozo)
drop trigger if exists pedidos_caja_abierta on public.pedidos;
create trigger pedidos_caja_abierta
    before insert on public.pedidos
    for each row execute function privado.exigir_caja_abierta();

-- Confirmar un pedido pendiente
drop trigger if exists pedidos_confirmar_caja_abierta on public.pedidos;
create trigger pedidos_confirmar_caja_abierta
    before update of estado on public.pedidos
    for each row when (old.estado = 'pendiente' and new.estado = 'confirmado')
    execute function privado.exigir_caja_abierta();

-- Cobrar una cuenta (liberar una mesa sin consumo, 'anulada', sí se permite)
drop trigger if exists cuentas_cobrar_caja_abierta on public.cuentas;
create trigger cuentas_cobrar_caja_abierta
    before update of estado on public.cuentas
    for each row when (old.estado = 'abierta' and new.estado = 'cerrada')
    execute function privado.exigir_caja_abierta();


-- ---------------------------------------------------------------------
-- 3. ABRIR Y CERRAR
-- ---------------------------------------------------------------------

create or replace function public.abrir_caja(p_monto_inicial numeric)
returns public.cierres_caja
language plpgsql security definer set search_path = ''
as $$
declare
    v_turno public.cierres_caja;
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;
    if p_monto_inicial is null or p_monto_inicial < 0 or p_monto_inicial > 100000000 then
        raise exception 'Monto inicial no válido';
    end if;
    if exists (select 1 from public.cierres_caja where estado = 'abierta') then
        raise exception 'La caja ya está abierta';
    end if;

    insert into public.cierres_caja (estado, abierta_at, abierta_por, monto_inicial, hasta)
    values ('abierta', now(), (select auth.uid()), round(p_monto_inicial), null)
    returning * into v_turno;
    return v_turno;
end;
$$;

-- El turno abierto, o nada si la caja está cerrada
create or replace function public.turno_actual()
returns public.cierres_caja
language sql stable security definer set search_path = ''
as $$
    select c.* from public.cierres_caja c
    where c.estado = 'abierta' and public.is_staff();
$$;

drop function if exists public.cierre_caja();

create or replace function public.cierre_caja(p_efectivo_contado numeric)
returns public.cierres_caja
language plpgsql security definer set search_path = ''
as $$
declare
    v_turno public.cierres_caja;
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;
    if p_efectivo_contado is null or p_efectivo_contado < 0 or p_efectivo_contado > 100000000000 then
        raise exception 'Indica el efectivo contado en la caja';
    end if;

    select * into v_turno from public.cierres_caja where estado = 'abierta' for update;
    if not found then raise exception 'La caja no está abierta'; end if;

    update public.cuentas set cierre_id = v_turno.id
        where estado = 'cerrada' and cierre_id is null;

    update public.cierres_caja c set
        estado              = 'cerrada',
        hasta               = now(),
        desde               = c.abierta_at,
        cerrado_por         = (select auth.uid()),
        cuentas             = t.cuentas,
        total_efectivo      = t.efectivo,
        total_tarjeta       = t.tarjeta,
        total_transferencia = t.transferencia,
        total               = t.total,
        efectivo_esperado   = c.monto_inicial + t.efectivo,
        efectivo_contado    = round(p_efectivo_contado),
        diferencia          = round(p_efectivo_contado) - (c.monto_inicial + t.efectivo)
    from (
        select count(*) as cuentas,
               coalesce(sum(total) filter (where metodo_pago = 'efectivo'), 0)      as efectivo,
               coalesce(sum(total) filter (where metodo_pago = 'tarjeta'), 0)       as tarjeta,
               coalesce(sum(total) filter (where metodo_pago = 'transferencia'), 0) as transferencia,
               coalesce(sum(total), 0) as total
        from public.cuentas where cierre_id = v_turno.id
    ) t
    where c.id = v_turno.id
    returning c.* into v_turno;

    return v_turno;
end;
$$;


-- ---------------------------------------------------------------------
-- 4. RESUMEN: ahora incluye el turno (monto inicial y arqueo)
-- p_cierre_id null = turno abierto
-- ---------------------------------------------------------------------

create or replace function public.resumen_ventas(p_cierre_id bigint default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
    v_resultado jsonb;
    v_turno     public.cierres_caja;
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;

    if p_cierre_id is null then
        select * into v_turno from public.cierres_caja where estado = 'abierta';
    else
        select * into v_turno from public.cierres_caja where id = p_cierre_id;
    end if;

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
        'desde',   coalesce(v_turno.abierta_at, (select min(cerrada_at) from cuentas_turno)),
        'hasta',   coalesce(v_turno.hasta, (select max(cerrada_at) from cuentas_turno)),
        'cuentas', (select count(*) from cuentas_turno),
        'total',   (select coalesce(sum(total), 0) from cuentas_turno),
        'por_metodo', jsonb_build_object(
            'efectivo',      (select coalesce(sum(total), 0) from cuentas_turno where metodo_pago = 'efectivo'),
            'tarjeta',       (select coalesce(sum(total), 0) from cuentas_turno where metodo_pago = 'tarjeta'),
            'transferencia', (select coalesce(sum(total), 0) from cuentas_turno where metodo_pago = 'transferencia')
        ),
        'turno', case when v_turno.id is null then null else jsonb_build_object(
            'id',                v_turno.id,
            'estado',            v_turno.estado,
            'monto_inicial',     v_turno.monto_inicial,
            'efectivo_esperado', coalesce(v_turno.efectivo_esperado,
                v_turno.monto_inicial + (select coalesce(sum(total), 0) from cuentas_turno where metodo_pago = 'efectivo')),
            'efectivo_contado',  v_turno.efectivo_contado,
            'diferencia',        v_turno.diferencia
        ) end,
        'productos', coalesce(
            (select jsonb_agg(to_jsonb(pt) order by pt.cantidad desc, pt.nombre) from productos_turno pt),
            '[]'::jsonb)
    ) into v_resultado;

    return v_resultado;
end;
$$;


-- ---------------------------------------------------------------------
-- 5. INFORME DIARIO DE MOVIMIENTOS
-- Todo lo que pasó en un día (hora de Asunción): cobros por método,
-- mesas liberadas sin consumo, anulaciones (rollbacks) y los turnos
-- con su arqueo.
-- ---------------------------------------------------------------------

create or replace function public.informe_diario(p_fecha date default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
    v_dia date := coalesce(p_fecha, (now() at time zone 'America/Asuncion')::date);
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;

    return jsonb_build_object(
        'fecha', v_dia,
        'cobros', (
            select jsonb_build_object(
                'cuentas', count(*),
                'total', coalesce(sum(total), 0),
                'efectivo',      coalesce(sum(total) filter (where metodo_pago = 'efectivo'), 0),
                'tarjeta',       coalesce(sum(total) filter (where metodo_pago = 'tarjeta'), 0),
                'transferencia', coalesce(sum(total) filter (where metodo_pago = 'transferencia'), 0))
            from public.cuentas
            where estado = 'cerrada' and (cerrada_at at time zone 'America/Asuncion')::date = v_dia),
        'mesas_sin_consumo', (
            select count(*) from public.cuentas
            where estado = 'anulada' and (cerrada_at at time zone 'America/Asuncion')::date = v_dia),
        'anulaciones', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'at', a.at, 'pedido_id', a.registro_id, 'motivo', a.motivo, 'usuario', u.email)
                   order by a.at)
            from public.auditoria a left join auth.users u on u.id = a.user_id
            where a.accion = 'rollback' and (a.at at time zone 'America/Asuncion')::date = v_dia), '[]'::jsonb),
        'turnos', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', id, 'estado', estado, 'abierta_at', abierta_at, 'hasta', hasta,
                       'monto_inicial', monto_inicial, 'efectivo_esperado', efectivo_esperado,
                       'efectivo_contado', efectivo_contado, 'diferencia', diferencia, 'total', total)
                   order by abierta_at)
            from public.cierres_caja
            where (abierta_at at time zone 'America/Asuncion')::date = v_dia), '[]'::jsonb)
    );
end;
$$;


-- ---------------------------------------------------------------------
-- 6. PERMISOS
-- ---------------------------------------------------------------------

revoke execute on function
    public.abrir_caja(numeric),
    public.turno_actual(),
    public.cierre_caja(numeric),
    public.informe_diario(date)
from public, anon, authenticated;

grant execute on function
    public.abrir_caja(numeric),
    public.turno_actual(),
    public.cierre_caja(numeric),
    public.informe_diario(date)
to authenticated;
