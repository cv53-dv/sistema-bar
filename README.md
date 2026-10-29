# Sistema Bar

Sistema web para bares y restaurantes: carta digital con pedidos desde el QR de la mesa, toma de pedidos por mozos, comandas impresas en tiempo real, control de stock, cobro por mesa con cierre de caja y registro de datos para facturación. Montos en guaraníes.

Funciona en el navegador (celular, tablet o PC), sin instalar nada. El frontend es HTML, CSS y JavaScript sin frameworks; los datos, el login y las imágenes están en [Supabase](https://supabase.com).

## Pantallas

| Pantalla | Archivo | Quién la usa | Para qué |
| --- | --- | --- | --- |
| Carta | `index.html` | Clientes | Ver la carta; desde el QR de la mesa, armar y enviar pedidos |
| Ingreso | `login.html` | Personal | Iniciar sesión con usuario y contraseña; cada rol entra a su pantalla |
| Mesas | `mozo.html` | Mozos y admin | Ver mesas, confirmar pedidos QR, cargar pedidos, precuenta y cobro |
| Comandas | `comandas.html` | Barra o cocina | Recibir los pedidos e imprimirlos en 80 mm (automático o manual) |
| Caja | `caja.html` | Admin | Turno, cierre de caja, informe diario y Excel, facturas por emitir, auditoría, mesas y QR, personal |
| Productos | `admin.html` | Admin | Productos, precios, fotos, categorías, inventario y movimientos de stock |

## Cómo funciona

- **Roles:** `admin` y `mozo` (tabla `personal`). El cliente no necesita cuenta.
- **Usuarios:** el personal entra con un nombre de usuario (3 a 40 caracteres: letras, números, `.`, `_`, `-`). Internamente cada usuario es la cuenta `usuario@usuarios.mashbeer.invalid` de Supabase Auth; ese correo no existe y no recibe mensajes.
- **Pedidos:** el pedido del cliente por QR queda *pendiente* hasta que un mozo lo confirma; el del mozo entra confirmado. Solo los confirmados se imprimen, descuentan stock y se cobran.
- **Stock:** por unidades; se descuenta al confirmar, el producto se marca agotado en 0 y vuelve al reponer. Stock vacío = sin control (cócteles, platos). Cada entrada, ajuste o venta queda en `stock_movimientos`.
- **Caja:** cobro en efectivo (con vuelto), tarjeta o transferencia; turnos con monto inicial y cierre de caja con resumen por método y por producto. Informe diario e informe Excel por rango de fechas (hasta 367 días, hora de Asunción).
- **Auditoría:** los cambios en las tablas principales y las anulaciones de pedidos (con motivo) quedan registrados en `auditoria`, que no se puede modificar ni borrar.
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

3. Crea los usuarios en el panel de Supabase local (http://127.0.0.1:54323 → Authentication → Users → Add user, con *Auto Confirm User*). El correo debe ser `<usuario>@usuarios.mashbeer.invalid`, por ejemplo `admin@usuarios.mashbeer.invalid` para entrar como `admin`.
4. Asigna el primer admin en el SQL Editor:

   ```sql
   insert into public.personal (user_id, rol)
   select id, 'admin' from auth.users where email = 'admin@usuarios.mashbeer.invalid';
   ```

   Los siguientes usuarios se asignan desde **Caja → Personal**, escribiendo solo el nombre de usuario.
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
├── login.html, login.js         Ingreso del personal
├── mozo.html                    Mesas, pedidos y cobro
│   ├── mozo-mesas.js            Mesas, pedidos y precuenta
│   ├── mozo-catalogo.js         Catálogo para cargar pedidos
│   ├── mozo-cobro.js            Cobro y datos de facturación
│   └── pedido-catalogo.css      Estilos del catálogo
├── comandas.html, comandas.js   Estación de impresión
├── caja.html, caja.js           Caja, facturas, mesas/QR y personal
│   ├── turno.js                 Turno de caja
│   ├── informes.js, excel.js    Informe diario y exportación a Excel
│   └── auditoria.js             Registro de auditoría
├── admin.html, admin.js         Productos y categorías
│   └── stock.js                 Inventario y movimientos de stock
├── utils.js                     Código compartido (roles, tickets, RUC, formatos)
├── config.js                    Configuración
├── style.css                    Estilos (responsive)
├── img/                         Imágenes de los productos de ejemplo
└── supabase/
    ├── migrations/              Esquema, RLS y funciones (en orden)
    └── seed.sql                 Datos de ejemplo
```
