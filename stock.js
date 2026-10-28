// stock.js — Informes de stock en Productos: inventario actual y movimientos por rango (solo admin)

function csvDescargar(nombre, encabezados, filas) {
    const celda = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const texto = [encabezados, ...filas].map(f => f.map(celda).join(';')).join('\r\n');
    const enlace = document.createElement('a');
    enlace.href = URL.createObjectURL(new Blob(['﻿' + texto], { type: 'text/csv;charset=utf-8' }));
    enlace.download = nombre;
    enlace.click();
    URL.revokeObjectURL(enlace.href);
}

function fechaLocalAIso(id) {
    const v = document.getElementById(id).value;
    return v ? new Date(v).toISOString() : null;
}

let inventarioInforme = [];
let movimientosInforme = [];

async function cargarInventarioActual() {
    try {
        inventarioInforme = await llamarRpc('inventario_actual');
        document.getElementById('tabla-inventario').innerHTML = inventarioInforme.length
            ? inventarioInforme.map(p => `
                <tr>
                    <td>${escapeHtml(p.nombre)}</td>
                    <td>${escapeHtml(p.categoria)}</td>
                    <td class="num">${p.stock === null ? 'sin control' : Number(p.stock)}</td>
                    <td>${escapeHtml(p.estado)}</td>
                </tr>`).join('')
            : '<tr><td colspan="4" class="vacio">Sin productos</td></tr>';
    } catch (error) {
        alert("Error al cargar el inventario: " + error.message);
    }
}

function descargarInventario() {
    csvDescargar('inventario-actual.csv', ['Producto', 'Categoría', 'Stock', 'Estado'],
        inventarioInforme.map(p => [p.nombre, p.categoria, p.stock === null ? 'sin control' : p.stock, p.estado]));
}

async function cargarMovimientosStock() {
    try {
        movimientosInforme = await llamarRpc('movimientos_stock', {
            p_desde: fechaLocalAIso('mov-desde'),
            p_hasta: fechaLocalAIso('mov-hasta'),
            p_producto: Number(document.getElementById('mov-producto').value) || null,
            p_tipo: document.getElementById('mov-tipo').value || null,
            p_limite: 1000
        });
        document.getElementById('tabla-movimientos').innerHTML = movimientosInforme.length
            ? movimientosInforme.map(m => `
                <tr>
                    <td>${formatoFechaHora(m.at)}</td>
                    <td>${escapeHtml(m.producto)}</td>
                    <td>${escapeHtml(m.tipo)}</td>
                    <td class="num">${Number(m.cantidad) > 0 ? '+' : ''}${Number(m.cantidad)}</td>
                    <td class="num">${m.stock_resultante === null ? '—' : Number(m.stock_resultante)}</td>
                    <td>${escapeHtml(m.email || 'sistema')}${m.pedido_id ? ` · pedido #${Number(m.pedido_id)}` : ''}</td>
                    <td>${escapeHtml(m.motivo || '')}</td>
                </tr>`).join('')
            : '<tr><td colspan="7" class="vacio">Sin movimientos en ese rango</td></tr>';
    } catch (error) {
        alert("Error al cargar los movimientos: " + error.message);
    }
}

function descargarMovimientos() {
    csvDescargar('movimientos-stock.csv',
        ['Fecha y hora', 'Producto', 'Tipo', 'Cantidad', 'Stock resultante', 'Pedido', 'Usuario', 'Motivo'],
        movimientosInforme.map(m => [m.at, m.producto, m.tipo, m.cantidad, m.stock_resultante, m.pedido_id, m.email, m.motivo]));
}

function llenarSelectorMovimientos() {
    document.getElementById('mov-producto').innerHTML = '<option value="">Todos los productos</option>'
        + inventarioGlobal.map(p => `<option value="${Number(p.id)}">${escapeHtml(p.nombre)}</option>`).join('');
}

function abrirInformesStock() {
    document.getElementById('informes-stock').style.display = 'block';
    llenarSelectorMovimientos();
    cargarInventarioActual();
    cargarMovimientosStock();
}
