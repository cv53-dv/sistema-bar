// mozo.js — Mesas, pedidos y cobro

const NOMBRE_METODO = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia' };

let rolActual = null;
let mesas = [];            // mesas activas
let cuentasAbiertas = [];  // cuentas abiertas con sus pedidos e items
let mesaActual = null;     // mesa abierta en la vista de detalle
let productos = [];        // productos para el selector de pedidos
let categorias = [];       // categorías con productos, en el orden del admin
let seleccion = {};        // producto_id -> cantidad del pedido en armado
let filtroCategoria = 'todos';
let metodoPago = null;
let recargaTimer;

// 1. INICIO
async function iniciar() {
    rolActual = await requerirRol(['admin', 'mozo']);
    if (!rolActual) return;
    await cargarDatos();
    suscribirCambios();
    setInterval(cargarDatos, 30000); // respaldo si se corta el tiempo real
}

async function cargarDatos() {
    const [resMesas, resCuentas] = await Promise.all([
        supabaseClient.from('mesas').select('id, nombre').eq('activa', true).order('id'),
        supabaseClient.from('cuentas')
            .select(`id, mesa_id, abierta_at,
                     pedidos (id, origen, estado, nota, created_at, confirmado_at, impreso_at,
                              pedido_items (id, nombre, cantidad, precio_unitario, nota))`)
            .eq('estado', 'abierta')
    ]);

    const error = resMesas.error || resCuentas.error;
    if (error) { mostrarAviso("Error al cargar: " + error.message, 'error'); return; }

    mesas = resMesas.data;
    cuentasAbiertas = resCuentas.data;
    renderMesas();
    if (mesaActual) renderMesa();
}

// Tiempo real: cualquier cambio en pedidos o cuentas recarga la vista
function suscribirCambios() {
    supabaseClient.channel('mozo')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'pedidos' }, (payload) => {
            if (payload.eventType === 'INSERT' && payload.new.origen === 'cliente') {
                avisarPedidoCliente(payload.new.mesa_id);
            }
            recargarPronto();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'cuentas' }, recargarPronto)
        .subscribe();
}

function recargarPronto() {
    clearTimeout(recargaTimer);
    recargaTimer = setTimeout(cargarDatos, 300);
}

function avisarPedidoCliente(mesaId) {
    const mesa = mesas.find(m => m.id === mesaId);
    mostrarAviso(`Nuevo pedido por QR en ${mesa ? mesa.nombre : 'una mesa'}`);
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

// 2. CÁLCULOS
function totalPedido(pedido) {
    return pedido.pedido_items.reduce((suma, i) => suma + i.cantidad * i.precio_unitario, 0);
}

function cuentaDeMesa(mesaId) {
    return cuentasAbiertas.find(c => c.mesa_id === mesaId) || null;
}

function totalCuenta(cuenta) {
    if (!cuenta) return 0;
    return cuenta.pedidos.filter(p => p.estado === 'confirmado').reduce((s, p) => s + totalPedido(p), 0);
}

function cantidadPendientes(cuenta) {
    return cuenta ? cuenta.pedidos.filter(p => p.estado === 'pendiente').length : 0;
}

// Agrupa los items confirmados de la cuenta para la precuenta y el ticket
function lineasDeCuenta(cuenta) {
    const lineas = {};
    cuenta.pedidos.filter(p => p.estado === 'confirmado').forEach(p => {
        p.pedido_items.forEach(i => {
            const clave = `${i.nombre}|${i.precio_unitario}`;
            if (!lineas[clave]) lineas[clave] = { nombre: i.nombre, cantidad: 0, importe: 0 };
            lineas[clave].cantidad += i.cantidad;
            lineas[clave].importe += i.cantidad * i.precio_unitario;
        });
    });
    return Object.values(lineas);
}

// 3. VISTA DE MESAS
function renderMesas() {
    const grid = document.getElementById('grid-mesas');
    if (mesas.length === 0) {
        grid.innerHTML = '<div class="vacio" style="grid-column:1/-1;">No hay mesas. Un administrador puede crearlas en Caja → Mesas.</div>';
        return;
    }

    grid.innerHTML = mesas.map(mesa => {
        const cuenta = cuentaDeMesa(mesa.id);
        const pendientes = cantidadPendientes(cuenta);
        const clases = ['mesa-card'];
        if (cuenta) clases.push('ocupada');
        if (pendientes) clases.push('con-pendientes');

        const info = cuenta ? formatoPrecio(totalCuenta(cuenta)) : 'Libre';
        const alerta = pendientes ? `<div class="alerta-pendiente">⚠ ${pendientes} por confirmar</div>` : '';

        return `
            <button class="${clases.join(' ')}" onclick="abrirMesa(${Number(mesa.id)})">
                <span class="mesa-nombre">${escapeHtml(mesa.nombre)}</span>
                <span><div class="mesa-info">${info}</div>${alerta}</span>
            </button>`;
    }).join('');
}

function abrirMesa(id) {
    mesaActual = mesas.find(m => m.id === id) || null;
    if (!mesaActual) return;
    document.getElementById('vista-mesas').style.display = 'none';
    document.getElementById('vista-mesa').style.display = 'block';
    renderMesa();
    window.scrollTo({ top: 0 });
}

function volverAMesas() {
    mesaActual = null;
    document.getElementById('vista-mesa').style.display = 'none';
    document.getElementById('vista-mesas').style.display = 'block';
    renderMesas();
}

// 4. VISTA DE UNA MESA
function renderMesa() {
    const cuenta = cuentaDeMesa(mesaActual.id);
    const total = totalCuenta(cuenta);

    document.getElementById('mesa-titulo').textContent = mesaActual.nombre;
    document.getElementById('mesa-total').textContent = formatoPrecio(total);
    document.getElementById('btn-precuenta').disabled = total === 0;
    document.getElementById('btn-cobrar').disabled = !cuenta;

    const lista = document.getElementById('lista-pedidos');
    if (!cuenta || cuenta.pedidos.length === 0) {
        lista.innerHTML = '<div class="vacio">Mesa libre. Usa "Nuevo pedido" para empezar.</div>';
        return;
    }

    const pedidos = [...cuenta.pedidos].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    lista.innerHTML = pedidos.map(htmlPedido).join('');
}

function htmlPedido(p) {
    const id = Number(p.id);
    const tags = [`<span class="tag tag-${p.estado}">${escapeHtml(p.estado)}</span>`];
    if (p.origen === 'cliente') tags.push('<span class="tag tag-qr">QR cliente</span>');
    if (p.impreso_at) tags.push('<span class="tag tag-impreso">impreso</span>');

    const items = p.pedido_items.map(i => `
        <li>
            <span><span class="cant">${Number(i.cantidad)}×</span>${escapeHtml(i.nombre)}
                ${i.nota ? `<span class="nota-item">» ${escapeHtml(i.nota)}</span>` : ''}</span>
            <span>${formatoPrecio(i.cantidad * i.precio_unitario)}</span>
        </li>`).join('');

    let acciones = '';
    if (p.estado === 'pendiente') {
        acciones = `
            <button class="btn-sec ok" onclick="confirmarPedido(${id}, this)"><span class="material-icons">check</span>Confirmar</button>
            <button class="btn-sec peligro" onclick="rechazarPedido(${id}, this)"><span class="material-icons">close</span>Rechazar</button>`;
    } else if (p.estado === 'confirmado') {
        acciones = `<button class="btn-sec" onclick="imprimirPedido(${id})"><span class="material-icons">print</span>Comanda</button>`;
        if (rolActual === 'admin') {
            acciones += `<button class="btn-sec peligro" onclick="anularPedido(${id}, this)"><span class="material-icons">undo</span>Anular</button>`;
        }
    }

    return `
        <div class="pedido-card ${escapeHtml(p.estado)}">
            <div class="pedido-head">
                <span class="titulo">Pedido #${id} <span class="hora">${formatoHora(p.created_at)}</span></span>
                <span style="display:flex; gap:5px;">${tags.join('')}</span>
            </div>
            <ul class="pedido-items">${items}</ul>
            ${p.nota ? `<div class="pedido-nota">${escapeHtml(p.nota)}</div>` : ''}
            <div class="pedido-acciones">${acciones}</div>
        </div>`;
}

// Ejecuta una acción con el botón deshabilitado y recarga al terminar
async function ejecutar(boton, accion, mensajeOk) {
    if (boton) boton.disabled = true;
    try {
        await accion();
        if (mensajeOk) mostrarAviso(mensajeOk);
        await cargarDatos();
    } catch (error) {
        mostrarAviso(error.message, 'error');
    } finally {
        if (boton) boton.disabled = false;
    }
}

function confirmarPedido(id, boton) {
    ejecutar(boton, () => llamarRpc('confirmar_pedido', { p_pedido_id: id }), "Pedido confirmado y enviado a comandas");
}

function rechazarPedido(id, boton) {
    if (!confirm("¿Rechazar este pedido del cliente?")) return;
    ejecutar(boton, () => llamarRpc('cancelar_pedido', { p_pedido_id: id }), "Pedido rechazado");
}

function anularPedido(id, boton) {
    const motivo = prompt("¿Anular este pedido? Se devolverá el stock y se quitará de la cuenta.\nMotivo de la anulación:");
    if (motivo === null) return;
    ejecutar(boton, () => llamarRpc('cancelar_pedido', { p_pedido_id: id, p_motivo: motivo }), "Pedido anulado");
}

function imprimirPedido(id) {
    const cuenta = cuentaDeMesa(mesaActual.id);
    const pedido = cuenta && cuenta.pedidos.find(p => p.id === id);
    if (pedido) imprimirComanda({ ...pedido, mesas: { nombre: mesaActual.nombre } });
}

function imprimirPrecuenta() {
    const cuenta = cuentaDeMesa(mesaActual.id);
    if (!cuenta) return;
    imprimirTicket({
        titulo: CONFIG.NOMBRE_BAR,
        subtitulo: `${mesaActual.nombre} · Precuenta · ${formatoFechaHora(new Date())}`,
        lineas: lineasDeCuenta(cuenta),
        total: totalCuenta(cuenta)
    });
}

// 5. NUEVO PEDIDO
async function abrirNuevoPedido() {
    let todasLasCategorias;
    const resProductos = await supabaseClient
        .from('productos')
        .select('id, nombre, precio, categoria_id, stock, estado')
        .eq('activo', true)
        .order('nombre');
    try {
        if (resProductos.error) throw resProductos.error;
        todasLasCategorias = await cargarCategorias();
    } catch (error) {
        mostrarAviso("Error al cargar productos: " + error.message, 'error');
        return;
    }

    productos = resProductos.data;
    // El personal ve también las categorías ocultas en la carta
    categorias = todasLasCategorias.filter(c => productos.some(p => p.categoria_id === c.id));
    seleccion = {};
    filtroCategoria = 'todos';
    document.getElementById('buscar-producto').value = '';
    document.getElementById('pedido-nota').value = '';
    document.getElementById('pedido-mesa-nombre').textContent = mesaActual.nombre;
    renderFiltros();
    renderSelector();
    actualizarResumenPedido();
    abrirModal('modal-pedido');
}

function renderFiltros() {
    const botones = [`<button class="filter-btn ${filtroCategoria === 'todos' ? 'active' : ''}" onclick="filtrarCategoria('todos')">Todo</button>`]
        .concat(categorias.map(c => {
            const id = Number(c.id);
            return `<button class="filter-btn ${filtroCategoria === id ? 'active' : ''}" onclick="filtrarCategoria(${id})">${escapeHtml(etiquetaCategoria(c))}</button>`;
        }));
    document.getElementById('selector-filtros').innerHTML = botones.join('');
}

function filtrarCategoria(categoria) {
    filtroCategoria = categoria;
    renderFiltros();
    renderSelector();
}

function renderSelector() {
    const termino = document.getElementById('buscar-producto').value.toLowerCase();
    const lista = productos.filter(p =>
        (filtroCategoria === 'todos' || p.categoria_id === filtroCategoria) &&
        p.nombre.toLowerCase().includes(termino));

    const contenedor = document.getElementById('selector-productos');
    if (lista.length === 0) {
        contenedor.innerHTML = '<div class="vacio">Sin resultados</div>';
        return;
    }

    contenedor.innerHTML = lista.map(p => {
        const id = Number(p.id);
        const agotado = p.estado === 'agotado';
        let stock = '';
        if (agotado) stock = '<span class="stock-prod stock-cero">agotado</span>';
        else if (p.stock !== null) stock = `<span class="stock-prod ${p.stock <= 5 ? 'stock-bajo' : ''}">stock ${Number(p.stock)}</span>`;

        return `
            <div class="producto-fila ${agotado ? 'sin-stock' : ''}">
                <div class="info-prod">
                    <span class="nombre-prod">${escapeHtml(p.nombre)}</span>
                    <span class="precio-prod">${formatoPrecio(p.precio)}</span>${stock}
                </div>
                <div class="qty-control">
                    <button onclick="cambiarCantidad(${id}, -1)">−</button>
                    <span class="qty" id="qty-${id}">${seleccion[id] || 0}</span>
                    <button onclick="cambiarCantidad(${id}, 1)">+</button>
                </div>
            </div>`;
    }).join('');
}

function cambiarCantidad(id, delta) {
    const producto = productos.find(p => p.id === id);
    if (!producto) return;

    const maximo = producto.stock !== null ? Math.min(50, producto.stock) : 50;
    const nueva = Math.max(0, Math.min(maximo, (seleccion[id] || 0) + delta));
    if (delta > 0 && nueva === (seleccion[id] || 0)) {
        mostrarAviso(`No hay más stock de ${producto.nombre}`, 'error');
    }

    seleccion[id] = nueva;
    const span = document.getElementById(`qty-${id}`);
    if (span) span.textContent = nueva;
    actualizarResumenPedido();
}

function itemsSeleccionados() {
    return Object.entries(seleccion)
        .filter(([, cantidad]) => cantidad > 0)
        .map(([id, cantidad]) => ({ producto_id: Number(id), cantidad }));
}

function actualizarResumenPedido() {
    const items = itemsSeleccionados();
    const unidades = items.reduce((s, i) => s + i.cantidad, 0);
    const total = items.reduce((s, i) => s + i.cantidad * productos.find(p => p.id === i.producto_id).precio, 0);
    document.getElementById('resumen-cantidad').textContent = `${unidades} producto${unidades === 1 ? '' : 's'}`;
    document.getElementById('resumen-total').textContent = formatoPrecio(total);
}

async function enviarPedido(boton) {
    const items = itemsSeleccionados();
    if (items.length === 0) { mostrarAviso("Agrega al menos un producto", 'error'); return; }

    boton.disabled = true;
    boton.textContent = "Enviando...";
    try {
        await llamarRpc('crear_pedido_mozo', {
            p_mesa_id: mesaActual.id,
            p_items: items,
            p_nota: document.getElementById('pedido-nota').value
        });
        cerrarModal('modal-pedido');
        mostrarAviso("Pedido enviado a comandas");
        await cargarDatos();
    } catch (error) {
        mostrarAviso(error.message, 'error');
    } finally {
        boton.disabled = false;
        boton.textContent = "ENVIAR PEDIDO";
    }
}

// 6. COBRO
async function abrirCobro() {
    const cuenta = cuentaDeMesa(mesaActual.id);
    if (!cuenta) return;

    if (cantidadPendientes(cuenta) > 0) {
        mostrarAviso("Hay pedidos sin confirmar. Confírmalos o recházalos antes de cobrar.", 'error');
        return;
    }

    const total = totalCuenta(cuenta);
    if (total === 0) {
        if (!confirm("La mesa no tiene consumos. ¿Liberarla?")) return;
        await ejecutar(null, () => llamarRpc('cerrar_cuenta', { p_cuenta_id: cuenta.id, p_metodo: null }), "Mesa liberada");
        volverAMesas();
        return;
    }

    metodoPago = null;
    document.querySelectorAll('.metodo-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('box-efectivo').style.display = 'none';
    document.getElementById('paga-con').value = '';
    document.getElementById('vuelto').textContent = '';
    document.getElementById('cobro-mesa').textContent = mesaActual.nombre;
    document.getElementById('cobro-total').textContent = formatoPrecio(total);
    document.getElementById('con-factura').checked = false;
    ['factura-documento', 'factura-razon', 'factura-email'].forEach(id => { document.getElementById(id).value = ''; });
    cambiarFactura(false);
    abrirModal('modal-cobro');
}

// --- Datos para factura (RUC o cédula) ---
let documentoTimer;

function cambiarFactura(activa) {
    document.getElementById('box-factura').style.display = activa ? 'block' : 'none';
    if (activa) {
        revisarDocumentoFactura();
        document.getElementById('factura-documento').focus();
    }
}

// Valida mientras se escribe y completa los datos si el cliente ya facturó antes
function revisarDocumentoFactura() {
    const texto = document.getElementById('factura-documento').value.trim();
    const ayuda = document.getElementById('documento-ayuda');
    const revision = revisarDocumento(texto);
    ayuda.textContent = texto ? revision.mensaje : AYUDA_DOCUMENTO;
    // En rojo solo cuando ya parece un RUC completo con el dígito equivocado
    ayuda.className = 'ayuda-campo' + (texto && revision.valido ? ' ok' : (/-\d$/.test(texto) ? ' error' : ''));

    clearTimeout(documentoTimer);
    if (!revision.valido) return;
    documentoTimer = setTimeout(async () => {
        const { data } = await supabaseClient.from('clientes_factura')
            .select('razon_social, email').eq('documento', revision.documento).maybeSingle();
        if (!data || revisarDocumento(document.getElementById('factura-documento').value).documento !== revision.documento) return;
        document.getElementById('factura-razon').value = data.razon_social;
        if (data.email) document.getElementById('factura-email').value = data.email;
        ayuda.textContent = `${revision.tipo === 'ci' ? 'Cédula' : 'RUC válido'} · cliente conocido, datos completados`;
    }, 300);
}

// null = consumidor final; si faltan datos lanza un error con el motivo
function datosFactura() {
    if (!document.getElementById('con-factura').checked) return null;
    const revision = revisarDocumento(document.getElementById('factura-documento').value);
    const razon_social = document.getElementById('factura-razon').value.trim();
    const email = document.getElementById('factura-email').value.trim();
    if (!revision.valido) throw new Error(`Documento: ${revision.mensaje}`);
    if (!razon_social) throw new Error("Falta el nombre o la razón social");
    return { documento: revision.documento, tipo: revision.tipo, razon_social, email: email || null };
}

function seleccionarMetodo(metodo) {
    metodoPago = metodo;
    document.querySelectorAll('.metodo-btn').forEach(b => b.classList.toggle('active', b.dataset.metodo === metodo));
    document.getElementById('box-efectivo').style.display = metodo === 'efectivo' ? 'block' : 'none';
    calcularVuelto();
}

function calcularVuelto() {
    const total = totalCuenta(cuentaDeMesa(mesaActual.id));
    const pagaCon = parseFloat(document.getElementById('paga-con').value);
    const el = document.getElementById('vuelto');
    if (isNaN(pagaCon)) { el.textContent = ''; return; }
    const diferencia = pagaCon - total;
    el.textContent = diferencia >= 0 ? `Vuelto: ${formatoPrecio(diferencia)}` : `Faltan ${formatoPrecio(-diferencia)}`;
    el.style.color = diferencia >= 0 ? 'var(--green-success)' : 'var(--red-danger)';
}

async function confirmarCobro(boton) {
    if (!metodoPago) { mostrarAviso("Elige el método de pago", 'error'); return; }

    let factura;
    try {
        factura = datosFactura();
    } catch (error) {
        mostrarAviso(error.message, 'error');
        return;
    }

    const cuenta = cuentaDeMesa(mesaActual.id);
    const lineas = lineasDeCuenta(cuenta);
    const pagaCon = parseFloat(document.getElementById('paga-con').value);
    const mesaNombre = mesaActual.nombre;

    boton.disabled = true;
    try {
        // El total definitivo lo calcula la base de datos
        // El tipo (RUC o cédula) lo vuelve a determinar la base de datos
        const pFactura = factura && { documento: factura.documento, razon_social: factura.razon_social, email: factura.email };
        const total = await llamarRpc('cerrar_cuenta', { p_cuenta_id: cuenta.id, p_metodo: metodoPago, p_factura: pFactura });

        if (document.getElementById('imprimir-ticket').checked) {
            const extra = [['Pago', NOMBRE_METODO[metodoPago]]];
            if (metodoPago === 'efectivo' && pagaCon >= total) {
                extra.push(['Paga con', formatoPrecio(pagaCon)], ['Vuelto', formatoPrecio(pagaCon - total)]);
            }
            imprimirTicket({
                titulo: CONFIG.NOMBRE_BAR,
                subtitulo: `${mesaNombre} · ${formatoFechaHora(new Date())}${factura ? ' · Detalle para facturación' : ''}`,
                lineas, total, extra, factura,
                pie: '¡Gracias por su visita!'
            });
        }

        cerrarModal('modal-cobro');
        mostrarAviso(`Cuenta cobrada: ${formatoPrecio(total)}`);
        volverAMesas();
        await cargarDatos();
    } catch (error) {
        mostrarAviso(error.message, 'error');
    } finally {
        boton.disabled = false;
    }
}

document.addEventListener('DOMContentLoaded', iniciar);
