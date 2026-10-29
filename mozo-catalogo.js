// Catálogo visual para tomar pedidos. Los cobros y RPC conservan su comportamiento.
let focoAntesDelCatalogo;
let cargandoCatalogo = false;
let enviandoPedido = false;

async function abrirNuevoPedido() {
    if (cargandoCatalogo || !mesaActual) return;
    cargandoCatalogo = true;
    try {
        const [res, todas] = await Promise.all([
            supabaseClient.from('productos')
                .select('id, nombre, precio, categoria_id, stock, estado, imagen_url')
                .eq('activo', true).order('nombre'),
            cargarCategorias()
        ]);
        if (res.error) throw res.error;
        productos = res.data || [];
        categorias = todas.filter(c => productos.some(p => p.categoria_id === c.id));
        seleccion = {};
        filtroCategoria = 'todos';
        document.getElementById('buscar-producto').value = '';
        document.getElementById('pedido-nota').value = '';
        document.getElementById('pedido-mesa-nombre').textContent = mesaActual.nombre;
        renderFiltros();
        renderSelector();
        actualizarResumenPedido();
        focoAntesDelCatalogo = document.activeElement;
        abrirModal('modal-pedido');
        document.body.classList.add('tomando-pedido');
        document.querySelector('.pedido-volver').focus();
    } catch (error) {
        mostrarAviso('No se pudo abrir el catálogo: ' + error.message, 'error');
    } finally {
        cargandoCatalogo = false;
    }
}

function renderFiltros() {
    const opciones = [{ id: 'todos', nombre: 'Todo el menú', emoji: '☰' }, ...categorias];
    document.getElementById('selector-filtros').innerHTML = opciones.map(c => {
        const id = c.id === 'todos' ? "'todos'" : Number(c.id);
        const foto = productos.find(p => p.categoria_id === c.id && p.imagen_url);
        const icono = foto
            ? `<img src="${escapeHtml(imagenPedido(foto.imagen_url))}" alt="" onerror="this.onerror=null;this.src='img/producto-sin-foto.svg'">`
            : `<span aria-hidden="true">${escapeHtml(c.emoji || '◉')}</span>`;
        return `<button type="button" data-categoria="${escapeHtml(c.id)}" aria-pressed="${filtroCategoria === c.id}" onclick="filtrarCategoria(${id})">${icono}<strong>${escapeHtml(c.nombre)}</strong></button>`;
    }).join('');
}

function filtrarCategoria(id) {
    filtroCategoria = id;
    renderFiltros();
    renderSelector();
    document.querySelector(`[data-categoria="${id}"]`).focus();
    document.querySelector('.pedido-catalogo').scrollTop = 0;
}

function imagenPedido(valor) {
    try {
        const url = new URL(valor || 'img/producto-sin-foto.svg', location.href);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : 'img/producto-sin-foto.svg';
    } catch { return 'img/producto-sin-foto.svg'; }
}

function maximoPedido(producto) {
    if (producto.estado === 'agotado') return 0;
    return producto.stock == null ? 50 : Math.max(0, Math.min(50, Number(producto.stock)));
}

function renderSelector() {
    const termino = document.getElementById('buscar-producto').value.trim().toLocaleLowerCase('es');
    const lista = productos.filter(p => (filtroCategoria === 'todos' || p.categoria_id === filtroCategoria)
        && p.nombre.toLocaleLowerCase('es').includes(termino));
    const categoria = categorias.find(c => c.id === filtroCategoria);
    document.getElementById('catalogo-categoria').textContent = categoria ? categoria.nombre : 'Todos los productos';
    const contenedor = document.getElementById('selector-productos');
    if (!lista.length) {
        contenedor.innerHTML = '<p class="catalogo-vacio">No encontramos ese producto. Probá con otro nombre o categoría.</p>';
        return;
    }
    contenedor.innerHTML = lista.map(p => {
        const id = Number(p.id), cantidad = seleccion[id] || 0, maximo = maximoPedido(p);
        const nombre = escapeHtml(p.nombre);
        const stock = maximo === 0 ? 'Agotado' : p.stock != null && p.stock <= 5 ? `Quedan ${Number(p.stock)}` : '';
        return `<article class="producto-tarjeta ${cantidad ? 'elegido' : ''} ${!maximo ? 'agotado' : ''}" id="tarjeta-${id}">
            <button type="button" class="producto-agregar" onclick="cambiarCantidad(${id}, 1)" aria-label="Agregar ${nombre}" ${cantidad >= maximo ? 'disabled' : ''}>
                <div class="producto-foto"><img src="${escapeHtml(imagenPedido(p.imagen_url))}" alt="${nombre}" loading="lazy" onerror="this.onerror=null;this.src='img/producto-sin-foto.svg'">${stock ? `<span class="producto-stock">${stock}</span>` : ''}</div>
                <h4>${nombre}</h4><span class="producto-precio">${formatoPrecio(p.precio)}</span>
            </button>
            <div class="producto-cantidad">
                <button type="button" onclick="cambiarCantidad(${id}, -1)" aria-label="Quitar uno de ${nombre}" ${!cantidad ? 'disabled' : ''}>−</button>
                <span id="qty-${id}" aria-label="Cantidad de ${nombre}">${cantidad}</span>
                <button type="button" onclick="cambiarCantidad(${id}, 1)" aria-label="Sumar uno de ${nombre}" ${cantidad >= maximo ? 'disabled' : ''}>+</button>
            </div>
        </article>`;
    }).join('');
}

function cambiarCantidad(id, delta) {
    if (enviandoPedido) return;
    const p = productos.find(p => p.id === id);
    if (!p) return;
    const antes = seleccion[id] || 0;
    const nueva = Math.max(0, Math.min(maximoPedido(p), antes + delta));
    if (delta > 0 && nueva === antes) mostrarAviso('Llegaste al stock disponible o al máximo de 50 por producto.', 'error');
    seleccion[id] = nueva;
    const tarjeta = document.getElementById(`tarjeta-${id}`);
    if (tarjeta) {
        document.getElementById(`qty-${id}`).textContent = nueva;
        tarjeta.classList.toggle('elegido', nueva > 0);
        const botones = tarjeta.querySelectorAll('button');
        botones[0].disabled = nueva >= maximoPedido(p);
        botones[1].disabled = nueva === 0;
        botones[2].disabled = nueva >= maximoPedido(p);
    }
    actualizarResumenPedido();
}

function itemsSeleccionados() {
    return Object.entries(seleccion).filter(([, cantidad]) => cantidad > 0)
        .map(([id, cantidad]) => ({ producto_id: Number(id), cantidad }));
}

function actualizarResumenPedido() {
    const items = itemsSeleccionados();
    const unidades = items.reduce((s, i) => s + i.cantidad, 0);
    const total = items.reduce((s, i) => s + i.cantidad * productos.find(p => p.id === i.producto_id).precio, 0);
    document.getElementById('resumen-cantidad').textContent = `${unidades} producto${unidades === 1 ? '' : 's'}`;
    document.getElementById('resumen-total').textContent = formatoPrecio(total);
    document.getElementById('btn-enviar-pedido').disabled = !unidades || enviandoPedido;
    const foco = document.activeElement;
    const recuperar = foco && foco.closest('#pedido-seleccion') ? [foco.dataset.id, foco.dataset.delta] : null;
    document.getElementById('pedido-seleccion').innerHTML = items.length ? items.map(i => {
        const p = productos.find(p => p.id === i.producto_id), nombre = escapeHtml(p.nombre);
        return `<div class="ticket-linea"><img src="${escapeHtml(imagenPedido(p.imagen_url))}" alt="" onerror="this.onerror=null;this.src='img/producto-sin-foto.svg'">
            <div><strong>${nombre}</strong><span>${formatoPrecio(p.precio * i.cantidad)}</span></div>
            <div class="ticket-cantidad"><button type="button" data-id="${p.id}" data-delta="-1" onclick="cambiarCantidad(${p.id}, -1)" aria-label="Quitar del pedido ${nombre}">−</button><span>${i.cantidad}</span><button type="button" data-id="${p.id}" data-delta="1" onclick="cambiarCantidad(${p.id}, 1)" aria-label="Sumar al pedido ${nombre}" ${i.cantidad >= maximoPedido(p) ? 'disabled' : ''}>+</button></div></div>`;
    }).join('') : '<div class="ticket-vacio"><span aria-hidden="true">＋</span><strong>Empezá por algo rico</strong><p>Elegí un producto del catálogo.<br>Lo vas a ver acá.</p></div>';
    if (recuperar) {
        const boton = document.querySelector(`#pedido-seleccion [data-id="${recuperar[0]}"][data-delta="${recuperar[1]}"]`);
        (boton && !boton.disabled ? boton : document.querySelector('.pedido-volver')).focus();
    }
}

function salirDelCatalogo() {
    cerrarModal('modal-pedido');
    document.body.classList.remove('tomando-pedido');
    if (focoAntesDelCatalogo && focoAntesDelCatalogo.isConnected) focoAntesDelCatalogo.focus();
}

function cerrarCatalogoPedido() {
    if (enviandoPedido) return;
    if ((itemsSeleccionados().length || document.getElementById('pedido-nota').value.trim())
        && !confirm('¿Salir sin enviar este pedido?')) return;
    salirDelCatalogo();
}

async function enviarPedido(boton) {
    const items = itemsSeleccionados();
    if (!items.length || enviandoPedido) return;
    enviandoPedido = true;
    boton.disabled = true;
    boton.textContent = 'Enviando…';
    document.getElementById('pedido-nota').disabled = true;
    document.querySelector('.pedido-volver').disabled = true;
    try {
        await llamarRpc('crear_pedido_mozo', { p_mesa_id: mesaActual.id, p_items: items,
            p_nota: document.getElementById('pedido-nota').value });
        salirDelCatalogo();
        mostrarAviso('Pedido enviado a comandas');
        await cargarDatos();
    } catch (error) {
        mostrarAviso(error.message, 'error');
    } finally {
        enviandoPedido = false;
        boton.disabled = false;
        boton.textContent = 'Enviar pedido';
        document.getElementById('pedido-nota').disabled = false;
        document.querySelector('.pedido-volver').disabled = false;
    }
}

// Mantiene el teclado dentro de la pantalla del pedido.
document.addEventListener('keydown', e => {
    if (!document.getElementById('modal-pedido').classList.contains('active')) return;
    if (e.key === 'Escape') { e.preventDefault(); cerrarCatalogoPedido(); }
    if (e.key !== 'Tab') return;
    const controles = [...document.querySelectorAll('#modal-pedido button:not(:disabled), #modal-pedido input:not(:disabled), #modal-pedido textarea:not(:disabled)')].filter(el => el.getClientRects().length);
    const primero = controles[0], ultimo = controles[controles.length - 1];
    if (e.shiftKey && document.activeElement === primero) { e.preventDefault(); ultimo.focus(); }
    else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primero.focus(); }
});
