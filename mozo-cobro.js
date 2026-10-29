// Cobro y datos de facturación: lógica existente, separada de la carga visual.
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

