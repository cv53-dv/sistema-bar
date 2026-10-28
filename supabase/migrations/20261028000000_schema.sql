-- =====================================================================
-- Demo Bar — Esquema y políticas RLS para Supabase
-- Ejecutar completo en: Supabase Dashboard → SQL Editor
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. TABLAS
-- ---------------------------------------------------------------------

-- Productos de la carta (index.html / admin.html)
create table if not exists public.productos (
    id          bigint generated always as identity primary key,
    nombre      text        not null check (char_length(nombre) between 1 and 120),
    precio      numeric(10,2) not null check (precio >= 0),
    categoria   text        not null check (categoria in (
                    'cocteles', 'cervezas', 'licores', 'bebidas_sin',
                    'italiana', 'fuertes', 'tapas')),
    descripcion text        check (char_length(descripcion) <= 1000),
    curiosidad  text        check (char_length(curiosidad) <= 500),
    imagen_url  text,
    destacado   boolean     not null default false,
    estado      text        not null default 'disponible'
                            check (estado in ('disponible', 'agotado')),
    activo      boolean     not null default true,   -- false = eliminado (borrado lógico)
    created_at  timestamptz not null default now()
);

-- Opiniones de clientes. El nombre de la FK debe ser exactamente
-- opiniones_producto_id_fkey porque script.js lo usa en el embed.
create table if not exists public.opiniones (
    id             bigint generated always as identity primary key,
    producto_id    bigint      not null,
    cliente_nombre text        not null default 'Anónimo'
                               check (char_length(cliente_nombre) between 1 and 60),
    comentario     text        check (char_length(comentario) <= 500),
    puntuacion     smallint    not null check (puntuacion between 1 and 5),
    created_at     timestamptz not null default now(),
    constraint opiniones_producto_id_fkey
        foreign key (producto_id) references public.productos (id) on delete cascade
);

create index if not exists opiniones_producto_id_idx on public.opiniones (producto_id);
create index if not exists productos_carta_idx on public.productos (activo, destacado desc, id desc);


-- ---------------------------------------------------------------------
-- 2. ADMINISTRADORES
-- Supabase permite registrarse a cualquiera por defecto, así que
-- "estar logueado" NO basta para ser admin. Solo los usuarios de esta
-- tabla pueden modificar la carta.
-- ---------------------------------------------------------------------

create table if not exists public.admins (
    user_id    uuid primary key references auth.users (id) on delete cascade,
    created_at timestamptz not null default now()
);

alter table public.admins enable row level security;
-- Sin políticas: nadie la lee ni la modifica desde la API.
-- Se gestiona solo desde el SQL Editor (ver paso 6).

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1 from public.admins where user_id = (select auth.uid())
    );
$$;

revoke execute on function public.is_admin() from public, anon;
grant  execute on function public.is_admin() to authenticated;


-- ---------------------------------------------------------------------
-- 3. RLS — PRODUCTOS
-- ---------------------------------------------------------------------

alter table public.productos enable row level security;

-- El público solo ve productos activos
drop policy if exists "productos: lectura publica" on public.productos;
create policy "productos: lectura publica"
    on public.productos for select
    to anon, authenticated
    using (activo = true);

-- Los admins ven todo (incluidos los eliminados)
drop policy if exists "productos: admin lee todo" on public.productos;
create policy "productos: admin lee todo"
    on public.productos for select
    to authenticated
    using ((select public.is_admin()));

drop policy if exists "productos: admin inserta" on public.productos;
create policy "productos: admin inserta"
    on public.productos for insert
    to authenticated
    with check ((select public.is_admin()));

drop policy if exists "productos: admin actualiza" on public.productos;
create policy "productos: admin actualiza"
    on public.productos for update
    to authenticated
    using ((select public.is_admin()))
    with check ((select public.is_admin()));

-- La app usa borrado lógico (activo = false); se permite DELETE real solo a admins
drop policy if exists "productos: admin elimina" on public.productos;
create policy "productos: admin elimina"
    on public.productos for delete
    to authenticated
    using ((select public.is_admin()));


-- ---------------------------------------------------------------------
-- 4. RLS — OPINIONES
-- ---------------------------------------------------------------------

alter table public.opiniones enable row level security;

-- El público solo puede leer la puntuación (para el promedio de estrellas).
-- Nombre y comentario de los clientes no se exponen.
revoke select on public.opiniones from anon, authenticated;
grant  select (id, producto_id, puntuacion) on public.opiniones to anon, authenticated;
grant  insert (producto_id, cliente_nombre, comentario, puntuacion) on public.opiniones to anon, authenticated;

drop policy if exists "opiniones: lectura publica" on public.opiniones;
create policy "opiniones: lectura publica"
    on public.opiniones for select
    to anon, authenticated
    using (true);

-- Cualquiera puede opinar, pero solo sobre productos activos y disponibles
drop policy if exists "opiniones: insertar publico" on public.opiniones;
create policy "opiniones: insertar publico"
    on public.opiniones for insert
    to anon, authenticated
    with check (
        exists (
            select 1 from public.productos p
            where p.id = producto_id
              and p.activo = true
              and p.estado = 'disponible'
        )
    );

-- Los admins pueden borrar opiniones (moderación)
drop policy if exists "opiniones: admin elimina" on public.opiniones;
create policy "opiniones: admin elimina"
    on public.opiniones for delete
    to authenticated
    using ((select public.is_admin()));

-- Vista para que los admins lean las opiniones completas (nombre y comentario)
create or replace view public.opiniones_admin
with (security_invoker = false)
as
    select o.*, p.nombre as producto_nombre
    from public.opiniones o
    join public.productos p on p.id = o.producto_id
    where public.is_admin();

revoke all on public.opiniones_admin from public, anon;
grant select on public.opiniones_admin to authenticated;


-- ---------------------------------------------------------------------
-- 5. STORAGE — bucket "imagenes" (fotos de productos)
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'imagenes', 'imagenes', true,
    5242880,  -- 5 MB
    array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']
)
on conflict (id) do update
    set public             = excluded.public,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

-- Lectura: el bucket es público, getPublicUrl() funciona sin política de select.
-- Escritura: solo admins.
drop policy if exists "imagenes: admin sube" on storage.objects;
create policy "imagenes: admin sube"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'imagenes' and (select public.is_admin()));

drop policy if exists "imagenes: admin actualiza" on storage.objects;
create policy "imagenes: admin actualiza"
    on storage.objects for update
    to authenticated
    using (bucket_id = 'imagenes' and (select public.is_admin()))
    with check (bucket_id = 'imagenes' and (select public.is_admin()));

drop policy if exists "imagenes: admin elimina" on storage.objects;
create policy "imagenes: admin elimina"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'imagenes' and (select public.is_admin()));


-- ---------------------------------------------------------------------
-- 6. DAR DE ALTA AL ADMIN (ejecutar aparte, después de crear el usuario)
--    a) Authentication → Users → "Add user" (email + contraseña)
--    b) Authentication → Sign In / Providers → desactivar "Allow new users to sign up"
--    c) Seguir el paso 8 de 20261028010000_pedidos.sql
--       (la tabla admins se reemplaza por public.personal con roles)
-- ---------------------------------------------------------------------
