-- =====================================================================
-- Demo Bar — Factura con RUC o cédula de identidad
-- RUC: número-dígito verificador (ej. 80012345-0)
-- Cédula: solo números, sin dígito verificador (ej. 1234567)
-- Los puntos y espacios se ignoran (1.234.567 = 1234567)
-- =====================================================================

-- 'ruc', 'ci' o null si no es un documento válido. Recibe el documento ya normalizado.
create or replace function public.tipo_documento(p_documento text)
returns text
language sql immutable set search_path = ''
as $$
    select case
        when public.ruc_valido(p_documento) then 'ruc'
        when p_documento ~ '^[0-9]{4,10}$' then 'ci'
    end;
$$;

-- Quita puntos y espacios
create or replace function public.normalizar_documento(p_documento text)
returns text
language sql immutable set search_path = ''
as $$
    select nullif(regexp_replace(coalesce(p_documento, ''), '[.\s]', '', 'g'), '');
$$;


-- ---------------------------------------------------------------------
-- Clientes y cuentas: "ruc" pasa a ser "documento" + su tipo
-- ---------------------------------------------------------------------

alter table public.clientes_factura drop constraint if exists clientes_factura_ruc_check;
do $$
begin
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'clientes_factura' and column_name = 'ruc') then
        alter table public.clientes_factura rename column ruc to documento;
    end if;
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'cuentas' and column_name = 'factura_ruc') then
        alter table public.cuentas rename column factura_ruc to factura_documento;
    end if;
end $$;

alter table public.clientes_factura drop constraint if exists clientes_factura_documento_check;
alter table public.clientes_factura add constraint clientes_factura_documento_check
    check (public.tipo_documento(documento) is not null);

alter table public.cuentas
    add column if not exists factura_tipo_documento text check (factura_tipo_documento in ('ruc', 'ci'));
update public.cuentas set factura_tipo_documento = 'ruc'
    where factura_documento is not null and factura_tipo_documento is null;


-- ---------------------------------------------------------------------
-- Cobro: p_factura = {"documento": "1234567" | "80012345-0", "razon_social": "...", "email": "..."}
-- (también acepta la clave "ruc" de la versión anterior)
-- ---------------------------------------------------------------------

create or replace function public.cerrar_cuenta(p_cuenta_id bigint, p_metodo text, p_factura jsonb default null)
returns numeric
language plpgsql security definer set search_path = ''
as $$
declare
    v_total     numeric(14,0);
    v_documento text;
    v_tipo      text;
    v_razon     text;
    v_email     text;
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
        v_documento := public.normalizar_documento(coalesce(p_factura->>'documento', p_factura->>'ruc'));
        v_tipo      := public.tipo_documento(v_documento);
        v_razon     := trim(p_factura->>'razon_social');
        v_email     := nullif(lower(trim(p_factura->>'email')), '');

        if v_tipo is null then
            raise exception 'Documento no válido: RUC con guion y dígito verificador (ej. 80012345-0) o número de cédula (ej. 1234567)';
        end if;
        if v_razon is null or char_length(v_razon) not between 1 and 120 then
            raise exception 'Falta el nombre o la razón social';
        end if;
        if v_email is not null and v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
            raise exception 'El email no es válido';
        end if;

        insert into public.clientes_factura (documento, razon_social, email, updated_at)
        values (v_documento, v_razon, v_email, now())
        on conflict (documento) do update
            set razon_social = excluded.razon_social,
                email = coalesce(excluded.email, public.clientes_factura.email),
                updated_at = now();
    end if;

    update public.cuentas
        set estado = 'cerrada', metodo_pago = p_metodo, total = v_total,
            cerrada_at = now(), cerrada_por = (select auth.uid()),
            factura_documento = v_documento, factura_tipo_documento = v_tipo,
            factura_razon_social = v_razon, factura_email = v_email,
            factura_estado = case when v_documento is not null then 'pendiente' end
        where id = p_cuenta_id;
    return v_total;
end;
$$;

revoke execute on function public.cerrar_cuenta(bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.cerrar_cuenta(bigint, text, jsonb) to authenticated;
