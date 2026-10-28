-- =====================================================================
-- Demo Bar — Datos para factura al cobrar
-- El sistema registra los datos (RUC, razón social) y la lista de
-- facturas por emitir. La factura legal (SIFEN) se emite por separado.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. RUC: formato y dígito verificador (módulo 11 de la SET)
-- ---------------------------------------------------------------------

create or replace function public.ruc_valido(p_ruc text)
returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
    v_base  text;
    v_dv    integer;
    v_total integer := 0;
    v_k     integer := 2;
    v_resto integer;
    i       integer;
begin
    if p_ruc is null or p_ruc !~ '^[0-9]{1,10}-[0-9]$' then
        return false;
    end if;
    v_base := split_part(p_ruc, '-', 1);
    v_dv   := split_part(p_ruc, '-', 2)::integer;

    for i in reverse char_length(v_base)..1 loop
        v_total := v_total + substr(v_base, i, 1)::integer * v_k;
        v_k := case when v_k = 11 then 2 else v_k + 1 end;
    end loop;

    v_resto := v_total % 11;
    return v_dv = case when v_resto > 1 then 11 - v_resto else 0 end;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. TABLAS
-- ---------------------------------------------------------------------

-- Clientes que pidieron factura: se recuerdan para autocompletar
create table if not exists public.clientes_factura (
    ruc          text primary key check (public.ruc_valido(ruc)),
    razon_social text not null check (char_length(trim(razon_social)) between 1 and 120),
    email        text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    updated_at   timestamptz not null default now()
);

alter table public.clientes_factura enable row level security;

drop policy if exists "clientes_factura: personal lee" on public.clientes_factura;
create policy "clientes_factura: personal lee" on public.clientes_factura
    for select to authenticated using ((select public.is_staff()));

-- Datos de factura guardados en la cuenta (copia: si el cliente cambia, la cuenta no)
alter table public.cuentas
    add column if not exists factura_ruc          text,
    add column if not exists factura_razon_social text,
    add column if not exists factura_email        text,
    add column if not exists factura_estado       text check (factura_estado in ('pendiente', 'emitida')),
    add column if not exists factura_numero       text check (char_length(factura_numero) <= 30),
    add column if not exists factura_emitida_at   timestamptz;

create index if not exists cuentas_facturas_pendientes_idx
    on public.cuentas (factura_estado) where factura_estado = 'pendiente';


-- ---------------------------------------------------------------------
-- 3. COBRO CON DATOS DE FACTURA
-- p_factura = null → consumidor final (sin datos)
-- p_factura = {"ruc": "80012345-0", "razon_social": "...", "email": "..."}
-- ---------------------------------------------------------------------

drop function if exists public.cerrar_cuenta(bigint, text);

create or replace function public.cerrar_cuenta(p_cuenta_id bigint, p_metodo text, p_factura jsonb default null)
returns numeric
language plpgsql security definer set search_path = ''
as $$
declare
    v_total  numeric(14,0);
    v_ruc    text;
    v_razon  text;
    v_email  text;
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

    if p_factura is not null then
        v_ruc   := upper(trim(p_factura->>'ruc'));
        v_razon := trim(p_factura->>'razon_social');
        v_email := nullif(lower(trim(p_factura->>'email')), '');

        if not public.ruc_valido(v_ruc) then
            raise exception 'RUC no válido: revisa el número y el dígito verificador (ej. 80012345-0)';
        end if;
        if v_razon is null or char_length(v_razon) not between 1 and 120 then
            raise exception 'Falta la razón social';
        end if;
        if v_email is not null and v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
            raise exception 'El email no es válido';
        end if;

        insert into public.clientes_factura (ruc, razon_social, email, updated_at)
        values (v_ruc, v_razon, v_email, now())
        on conflict (ruc) do update
            set razon_social = excluded.razon_social,
                email = coalesce(excluded.email, public.clientes_factura.email),
                updated_at = now();
    end if;

    update public.cuentas
        set estado = 'cerrada', metodo_pago = p_metodo, total = v_total,
            cerrada_at = now(), cerrada_por = (select auth.uid()),
            factura_ruc = v_ruc, factura_razon_social = v_razon, factura_email = v_email,
            factura_estado = case when v_ruc is not null then 'pendiente' end
        where id = p_cuenta_id;
    return v_total;
end;
$$;

-- Quien factura marca la factura como emitida, con su número (ej. 001-001-0000123)
create or replace function public.marcar_factura_emitida(p_cuenta_id bigint, p_numero text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
    if not public.is_admin() then raise exception 'No autorizado'; end if;
    if p_numero is null or char_length(trim(p_numero)) not between 1 and 30 then
        raise exception 'Escribe el número de la factura';
    end if;

    update public.cuentas
        set factura_estado = 'emitida', factura_numero = trim(p_numero), factura_emitida_at = now()
        where id = p_cuenta_id and factura_estado = 'pendiente';
    if not found then raise exception 'La factura no está pendiente'; end if;
end;
$$;

revoke execute on function
    public.cerrar_cuenta(bigint, text, jsonb),
    public.marcar_factura_emitida(bigint, text)
from public, anon, authenticated;
grant execute on function
    public.cerrar_cuenta(bigint, text, jsonb),
    public.marcar_factura_emitida(bigint, text)
to authenticated;
