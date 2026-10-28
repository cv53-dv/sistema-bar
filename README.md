# Sistema Bar

Sistema web para bares y restaurantes: carta digital con pedidos desde el QR de la mesa, toma de pedidos por mozos, comandas impresas en tiempo real, control de stock, cobro por mesa con cierre de caja y registro de datos para facturación. Montos en guaraníes.

Funciona en el navegador (celular, tablet o PC), sin instalar nada. El frontend es HTML, CSS y JavaScript sin frameworks; los datos, el login y las imágenes están en [Supabase](https://supabase.com).

## Pantallas

| Pantalla | Archivo | Quién la usa | Para qué |
| --- | --- | --- | --- |
| Carta | `index.html` | Clientes | Ver la carta; desde el QR de la mesa, armar y enviar pedidos |
| Ingreso | `login.html` | Personal | Iniciar sesión; cada rol entra a su pantalla |
| Mesas | `mozo.html` | Mozos y admin | Ver mesas, confirmar pedidos QR, cargar pedidos, precuenta y cobro |
| Comandas | `comandas.html` | Barra o cocina | Recibir los pedidos e imprimirlos en 80 mm (automático o manual) |
| Caja | `caja.html` | Admin | Turno, cierre de caja, facturas por emitir, mesas y QR, personal |
| Productos | `admin.html` | Admin | Productos, precios, fotos, stock y categorías |

## Cómo funciona

- **Roles:** `admin` y `mozo` (tabla `personal`). El cliente no necesita cuenta.
- **Pedidos:** el pedido del cliente por QR queda *pendiente* hasta que un mozo lo confirma; el del mozo entra confirmado. Solo los confirmados se imprimen, descuentan stock y se cobran.
- **Stock:** por unidades; se descuenta al confirmar, el producto se marca agotado en 0 y vuelve al reponer. Stock vacío = sin control (cócteles, platos).
- **Caja:** cobro en efectivo (con vuelto), tarjeta o transferencia; cierre de caja con resumen por método y por producto.
- **Facturación:** al cobrar se pueden cargar RUC (con dígito verificador) o cédula, nombre y email; la cuenta pasa a *Facturas por emitir*. Los tickets **no son factura legal** (imprimen "DOCUMENTO NO VÁLIDO COMO FACTURA"); la factura o el KuDE se emiten en el sistema de facturación del negocio.
- **Seguridad:** RLS en todas las tablas; precios, totales y stock se calculan en funciones de la base (`supabase/migrations`), nunca en el navegador.

## Puesta en marcha local

Requisitos: [Node.js](https://nodejs.org) y [Docker Desktop](https://www.docker.com/products/docker-desktop/) abierto.

```bash
# 1. Base de datos local (aplica migraciones y datos de ejemplo)
npx supabase start

# 2. Servidor web
npx http-server -p 8080 -c-1
```

3. Crea los usuarios en el panel de Supabase local (http://127.0.0.1:54323 → Authentication → Users → Add user, con *Auto Confirm User*).
4. Asigna el primer admin en el SQL Editor:

   ```sql
   insert into public.personal (user_id, rol)
   select id, 'admin' from auth.users where email = 'admin@tubar.com';
   ```

   Los siguientes usuarios se asignan desde **Caja → Personal**.
5. Abre http://localhost:8080/login.html.

Para probar desde el celular en la misma WiFi, pon la IP de la PC en `URL_PUBLICA` dentro de `config.js` (ver `ipconfig`) y abre `http://<IP>:8080`.

Comandos útiles: `npx supabase stop` (apaga, conserva datos) · `npx supabase db reset` (vuelve a crear todo desde cero; borra los usuarios).

## Configuración (`config.js`)

| Clave | Para qué |
| --- | --- |
| `NOMBRE_BAR` | Nombre que sale en tickets y comandas |
| `URL_PUBLICA` | Dirección que llevan los QR de las mesas |
| `SUPABASE_URL` / `SUPABASE_KEY` | Proyecto de Supabase en la nube (URL y clave publicable) |
| `GEMINI_KEY` | Clave para el "dato curioso" con IA (opcional) |

En `localhost` o en una IP de red local, `config.js` usa automáticamente el Supabase de Docker.

## Publicación

1. Crea un proyecto en Supabase y aplica las migraciones de `supabase/migrations` en orden (SQL Editor o `npx supabase db push`).
2. Completa `SUPABASE_URL`, `SUPABASE_KEY` y `URL_PUBLICA` en `config.js`.
3. Publica los archivos en cualquier hosting estático (GitHub Pages, Cloudflare Pages, Netlify).
4. En Supabase → Authentication, desactiva el registro público de usuarios.

Al cambiar archivos `.js` o `.css`, sube el número de versión (`?v=...`) en los HTML para que los navegadores no usen copias viejas.

## Estructura

```
├── index.html, script.js        Carta y pedido por QR
├── login.html                   Ingreso del personal
├── mozo.html, mozo.js           Mesas, pedidos y cobro
├── comandas.html, comandas.js   Estación de impresión
├── caja.html, caja.js           Caja, facturas, mesas/QR y personal
├── admin.html, admin.js         Productos, stock y categorías
├── utils.js                     Código compartido (roles, tickets, RUC, formatos)
├── config.js                    Configuración
├── style.css                    Estilos (responsive)
├── img/                         Imágenes de los productos de ejemplo
└── supabase/
    ├── migrations/              Esquema, RLS y funciones (en orden)
    └── seed.sql                 Datos de ejemplo
```
