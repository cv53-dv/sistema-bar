// turno.js — Apertura de caja e informe diario (solo admin)

async function abrirCaja(evento) {
    evento.preventDefault();
    const monto = Number(document.getElementById('monto-inicial').value);
    try {
        await llamarRpc('abrir_caja', { p_monto_inicial: monto });
        document.getElementById('monto-inicial').value = '';
        mostrarAviso("Caja abierta");
        await cargarTurno();
    } catch (error) {
        mostrarAviso(error.message, 'error');
    }
}

async function imprimirInformeDiario() {
    try {
        const fecha = document.getElementById('informe-fecha').value || null;
        const i = await llamarRpc('informe_diario', { p_fecha: fecha });
        const turnos = i.turnos.map(t => [
            `Turno #${t.id} · inicial ${formatoPrecio(t.monto_inicial)}`,
            t.estado === 'abierta' ? 'abierto' : `dif. ${formatoPrecio(t.diferencia)}`
        ]);
        const anulaciones = i.anulaciones.map(a => [
            `Anul. pedido #${a.pedido_id} ${formatoHora(a.at)}`, a.motivo || ''
        ]);
        imprimirTicket({
            titulo: CONFIG.NOMBRE_BAR,
            subtitulo: `Informe diario ${i.fecha}`,
            extra: [
                ['Cuentas cobradas', String(i.cobros.cuentas)],
                ['Efectivo', formatoPrecio(i.cobros.efectivo)],
                ['Tarjeta', formatoPrecio(i.cobros.tarjeta)],
                ['Transferencia', formatoPrecio(i.cobros.transferencia)],
                ['Mesas sin consumo', String(i.mesas_sin_consumo)],
                ...turnos,
                ...anulaciones
            ],
            total: i.cobros.total
        });
    } catch (error) {
        mostrarAviso(error.message, 'error');
    }
}
