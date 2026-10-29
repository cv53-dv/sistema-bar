// Un único RPC obtiene un corte consistente, autorizado en la base de datos.
function filasInforme(datos, desde, hasta) {
    const fecha = value => value ? new Date(value).toLocaleString('es-PY', {timeZone:'America/Asuncion'}) : '';
    const contexto = [['Mashbeer', `Desde ${desde} hasta ${hasta} inclusive`],
        ['Zona horaria', 'America/Asuncion'], ['Generado', fecha(datos.generado)], []];
    return [
        {name:'Ventas', rows:[...contexto,
            ['CUENTAS COBRADAS (excluye abiertas y anuladas)'],
            ['Cuenta','Fecha de cobro','Mesa','Medio de pago','Total Gs.'],
            ...datos.ventas.map(v=>[v.id,fecha(v.cerrada_at),v.mesa,v.metodo_pago,Number(v.total)]),
            ['TOTAL COBRADO','','','',datos.ventas.reduce((n,v)=>n+Number(v.total),0)],[],
            ['DETALLE DE PRODUCTOS DE ESAS CUENTAS (solo pedidos confirmados)'],
            ['Cuenta','Pedido','Producto','Cantidad','Precio unitario Gs.','Importe Gs.'],
            ...datos.items.map(i=>[i.cuenta_id,i.pedido_id,i.nombre,i.cantidad,Number(i.precio_unitario),Number(i.precio_unitario)*i.cantidad])]},
        {name:'Caja', rows:[...contexto,
            ['Cierres dentro del período y cajas aún abiertas que se abrieron en el período'],
            ['Turno','Estado','Apertura','Cierre','Monto inicial Gs.','Cuentas','Efectivo Gs.','Tarjeta Gs.','Transferencia Gs.','Total Gs.','Efectivo esperado Gs.','Efectivo contado Gs.','Diferencia Gs.'],
            ...datos.caja.map(c=>[c.id,c.estado,fecha(c.abierta_at || c.desde),fecha(c.hasta),Number(c.monto_inicial),
                c.estado==='abierta'?'':c.cuentas,...['total_efectivo','total_tarjeta','total_transferencia','total','efectivo_esperado','efectivo_contado','diferencia'].map(k=>c.estado==='abierta'||c[k]===null?'':Number(c[k]))])]},
        {name:'Stock', rows:[...contexto,
            ['MOVIMIENTOS DEL PERÍODO'],
            ['Fecha','Producto','Tipo','Cantidad','Stock resultante','Pedido','Motivo'],
            ...datos.stock.map(m=>[fecha(m.at),m.producto,m.tipo,m.cantidad,m.stock_resultante===null?'Sin control':m.stock_resultante,m.pedido_id,m.motivo]),[],
            ['INVENTARIO ACTUAL (no representa el stock a la fecha Hasta)',fecha(datos.generado)],
            ['Producto','Categoría','Stock actual','Estado','Activo'],
            ...datos.inventario.map(p=>[p.nombre,p.categoria,p.stock===null?'Sin control':p.stock,p.estado,p.activo?'Sí':'No'])]}
    ];
}

async function descargarInformeExcel(evento) {
    evento.preventDefault();
    const boton = document.getElementById('excel-descargar');
    if (boton.disabled) return;
    const aviso = document.getElementById('excel-aviso');
    const desde = document.getElementById('excel-desde').value;
    const hasta = document.getElementById('excel-hasta').value;
    if (!desde || !hasta || desde > hasta) { aviso.textContent = 'Revisá el rango de fechas.'; return; }
    boton.disabled = true;
    aviso.textContent = 'Preparando Excel…';
    try {
        const datos = await llamarRpc('informe_excel', {p_desde:desde,p_hasta:hasta});
        const blob = ExcelMashbeer.workbook(filasInforme(datos,desde,hasta));
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url;
        link.download = `mashbeer-${desde}-${hasta}.xlsx`;
        link.click();
        setTimeout(()=>URL.revokeObjectURL(url), 1000);
        aviso.textContent = `Excel descargado: ${datos.ventas.length} cuentas, ${datos.caja.length} turnos y ${datos.stock.length} movimientos.`;
    } catch (error) {
        aviso.textContent = 'No se pudo generar el informe: ' + error.message;
    } finally { boton.disabled = false; }
}

document.addEventListener('DOMContentLoaded', ()=>{
    const hoy = new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Asuncion'}).format(new Date());
    document.getElementById('excel-hasta').value = hoy;
    document.getElementById('excel-desde').value = hoy.slice(0,8) + '01';
});
