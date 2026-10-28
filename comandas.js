// comandas.js — Estación de impresión (la PC conectada a la impresora térmica)

const CLAVE_AUTO = 'comandas-auto-imprimir';

let comandas = [];
let autoImprimir = false;
let imprimiendo = false;
let idsConocidos = null;   // para detectar pedidos nuevos y avisar con sonido
let recargaTimer;
let pendientesQR = 0;     // pedidos de clientes esperando confirmación

async function iniciar() {
    const rol = await requerirRol(['admin', 'mozo']);
    if (!rol) return;

    try { autoImprimir = localStorage.getItem(CLAVE_AUTO) === '1'; } catch (e) { autoImprimir = false; }
    document.getElementById('auto-imprimir').checked = autoImprimir;

    await cargarComandas();
    supabaseClient.channel('comandas')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'pedidos' }, () => {
            clearTimeout(recargaTimer);
            recargaTimer = setTimeout(cargarComandas, 300);
        })
        .subscribe();
    setInterval(cargarComandas, 15000); // respaldo si se corta el tiempo real
}

function cambiarAutoImpresion(activo) {
    autoImprimir = activo;
    try { localStorage.setItem(CLAVE_AUTO, activo ? '1' : '0'); } catch (e) { /* sin almacenamiento */ }
    if (activo) imprimirPendientes();
}

async function cargarComandas() {
    const desde = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

    const [resPedidos, resPendientes] = await Promise.all([
        supabaseClient.from('pedidos')
            .select('id, origen, nota, created_at, confirmado_at, impreso_at, mesas (nombre), pedido_items (nombre, cantidad, nota)')
            .eq('estado', 'confirmado')
            .gte('confirmado_at', desde)
            .order('confirmado_at', { ascending: false })
            .limit(80),
        supabaseClient.from('pedidos')
            .select('id', { count: 'exact', head: true })
            .eq('estado', 'pendiente')
    ]);

    if (resPedidos.error) { mostrarAviso("Error al cargar: " + resPedidos.error.message, 'error'); return; }

    comandas = resPedidos.data;
    avisarNuevas();
    pendientesQR = resPendientes.count || 0;
    render();
    if (autoImprimir) imprimirPendientes();
}

function avisarNuevas() {
    const ids = new Set(comandas.map(c => c.id));
    if (idsConocidos) {
        const nuevas = comandas.filter(c => !idsConocidos.has(c.id) && !c.impreso_at);
        if (nuevas.length) sonar();
    }
    idsConocidos = ids;
}

// Pitido corto para avisar a la barra (sin archivos de audio)
function sonar() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        osc.frequency.value = 880;
        osc.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
    } catch (e) { /* el navegador bloqueó el audio */ }
}

function render() {
    const pendientes = pendientesQR;
    const porImprimir = comandas.filter(c => !c.impreso_at);
    const impresas = comandas.filter(c => c.impreso_at);

    document.getElementById('contador-por-imprimir').textContent = porImprimir.length;
    document.getElementById('lista-por-imprimir').innerHTML = porImprimir.length
        ? porImprimir.map(htmlComanda).join('')
        : '<div class="vacio" style="grid-column:1/-1;">Todo impreso ✓</div>';
    document.getElementById('lista-impresas').innerHTML = impresas.length
        ? impresas.map(htmlComanda).join('')
        : '<div class="vacio" style="grid-column:1/-1;">Sin comandas todavía</div>';

    const aviso = document.getElementById('aviso-pendientes');
    aviso.style.display = pendientes ? 'block' : 'none';
    aviso.innerHTML = pendientes
        ? `⚠ ${pendientes} pedido${pendientes === 1 ? '' : 's'} por QR esperando que un mozo lo confirme · <a href="mozo.html" style="color:var(--gold);">Ver mesas</a>`
        : '';
}

function htmlComanda(c) {
    const items = c.pedido_items.map(i => `
        <li><span><span class="cant">${Number(i.cantidad)}×</span>${escapeHtml(i.nombre)}
            ${i.nota ? `<span class="nota-item">» ${escapeHtml(i.nota)}</span>` : ''}</span></li>`).join('');

    return `
        <div class="pedido-card ${c.impreso_at ? '' : 'pendiente'}">
            <div class="pedido-head">
                <span class="titulo" style="font-size:1.1rem;">${escapeHtml(c.mesas?.nombre)}</span>
                <span class="hora">#${Number(c.id)} · ${formatoHora(c.confirmado_at)}</span>
            </div>
            <ul class="pedido-items">${items}</ul>
            ${c.nota ? `<div class="pedido-nota">${escapeHtml(c.nota)}</div>` : ''}
            <div class="pedido-acciones">
                ${c.origen === 'cliente' ? '<span class="tag tag-qr">QR</span>' : ''}
                <button class="btn-sec" onclick="imprimirUna(${Number(c.id)}, this)">
                    <span class="material-icons">print</span>${c.impreso_at ? 'Reimprimir' : 'Imprimir'}
                </button>
            </div>
        </div>`;
}

// Imprime una comanda a mano (o la reimprime)
async function imprimirUna(id, boton) {
    const comanda = comandas.find(c => c.id === id);
    if (!comanda) return;
    boton.disabled = true;
    try {
        if (!comanda.impreso_at) {
            await llamarRpc('marcar_impreso', { p_pedido_id: id });
            comanda.impreso_at = new Date().toISOString();
        }
        imprimirComanda(comanda);
        render();
        await cargarComandas();
    } catch (error) {
        mostrarAviso(error.message, 'error');
    } finally {
        boton.disabled = false;
    }
}

// Impresión automática: de la más vieja a la más nueva.
// marcar_impreso reserva el pedido, así dos equipos nunca imprimen el mismo.
async function imprimirPendientes() {
    if (imprimiendo) return;
    imprimiendo = true;
    try {
        const porImprimir = comandas.filter(c => !c.impreso_at).reverse();
        for (const comanda of porImprimir) {
            const reservado = await llamarRpc('marcar_impreso', { p_pedido_id: comanda.id });
            comanda.impreso_at = new Date().toISOString();
            if (reservado) imprimirComanda(comanda);
        }
    } catch (error) {
        mostrarAviso("Error al imprimir: " + error.message, 'error');
    } finally {
        imprimiendo = false;
        render();
    }
}

document.addEventListener('DOMContentLoaded', iniciar);
