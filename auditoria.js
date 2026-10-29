// auditoria.js — Registro de auditoría en Caja (solo admin, solo lectura)

function valorLocal(id) {
    const v = document.getElementById(id).value;
    return v ? new Date(v).toISOString() : null;
}

async function cargarAuditoria() {
    try {
        const filas = await llamarRpc('listar_auditoria', {
            p_desde:  valorLocal('aud-desde'),
            p_hasta:  valorLocal('aud-hasta'),
            p_tabla:  document.getElementById('aud-tabla').value || null,
            p_accion: document.getElementById('aud-accion').value || null,
            p_limite: 200
        });
        document.getElementById('tabla-auditoria').innerHTML = filas.length
            ? filas.map(f => `
                <tr>
                    <td>${formatoFechaHora(f.at)}</td>
                    <td>${escapeHtml(f.email || 'cliente / sistema')}</td>
                    <td>${escapeHtml(f.accion)}</td>
                    <td>${escapeHtml(f.tabla)} #${escapeHtml(f.registro_id || '')}</td>
                    <td>${escapeHtml(f.motivo || '')}</td>
                    <td><button class="icon-btn" title="Ver detalle" onclick='verDetalleAuditoria(${Number(f.id)})'><span class="material-icons">info</span></button></td>
                </tr>`).join('')
            : '<tr><td colspan="6" class="vacio">Sin movimientos en ese rango</td></tr>';
        auditoriaFilas = filas;
    } catch (error) {
        mostrarAviso("Error al cargar la auditoría: " + error.message, 'error');
    }
}

let auditoriaFilas = [];

function verDetalleAuditoria(id) {
    const f = auditoriaFilas.find(x => Number(x.id) === id);
    if (!f) return;
    alert(`Antes:\n${JSON.stringify(f.antes, null, 2)}\n\nDespués:\n${JSON.stringify(f.despues, null, 2)}`);
}
