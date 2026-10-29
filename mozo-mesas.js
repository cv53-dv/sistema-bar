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

document.addEventListener('DOMContentLoaded', iniciar);
