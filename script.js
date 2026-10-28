let searchTimeout;
let todosLosProductos = [];
let categoriasCarta = [];        // categorías visibles que tienen productos
let categoriaActiva = 'todos';
let productoActual = null;
let puntuacion = 0;

// 1. CARGAR MENÚ - Versión corregida y verificada
async function cargarMenu() {
    const grid = document.getElementById('menu-grid');
    if (grid) grid.innerHTML = '<p style="text-align:center; color:#888; grid-column:1/-1; padding:40px;">Cargando carta...</p>';

    try {
        if (typeof supabaseClient === 'undefined' || !supabaseClient) {
             throw new Error("supabaseClient no definido. Revisa config.js.");
        }

        // Usamos la relación explícita detectada en tu Schema (producto_id)
        const [{ data: productos, error }, categorias] = await Promise.all([
            supabaseClient
                .from('productos')
                .select(`
                    *,
                    opiniones!opiniones_producto_id_fkey (
                        puntuacion
                    )
                `)
                .eq('activo', true)
                .order('destacado', { ascending: false })
                .order('id', { ascending: false }),
            cargarCategorias()
        ]);

        if (error) throw error;

        // Solo productos de categorías visibles; solo categorías que tienen productos
        const visibles = new Set(categorias.filter(c => c.visible).map(c => c.id));
        const productosVisibles = (productos || []).filter(p => visibles.has(p.categoria_id));
        categoriasCarta = categorias.filter(c => c.visible && productosVisibles.some(p => p.categoria_id === c.id));
        if (categoriaActiva !== 'todos' && !categoriasCarta.some(c => c.id === categoriaActiva)) categoriaActiva = 'todos';
        renderizarFiltros();

        if (productosVisibles.length === 0) {
             todosLosProductos = [];
        } else {
            todosLosProductos = productosVisibles.map(prod => {
                const listaOpiniones = prod.opiniones || [];
                const total = listaOpiniones.length;
                const suma = listaOpiniones.reduce((acc, curr) => acc + (curr.puntuacion || 0), 0);
                prod.ratingPromedio = total ? (suma / total).toFixed(1) : null;
                return prod;
            });
        }

        aplicarFiltros();

    } catch (err) {
        console.error("Error en cargarMenu:", err);
        if (grid) {
            grid.innerHTML = `<div style="text-align:center; color:#ff5252; grid-column:1/-1; padding:20px;">
                                <h4>Error de Carga</h4>
                                <p style="font-size:0.9rem;">${escapeHtml(err.message)}</p>
                              </div>`;
        }
    }
}

// AQUÍ EMPIEZA TU FUNCIÓN SIGUIENTE, NO LA BORRES:
// function renderizarMenu(lista) { ...

// 2. RENDERIZAR
function renderizarMenu(lista) {
    const contenedor = document.getElementById('menu-grid');
    if (!contenedor) return;
    
    contenedor.innerHTML = '';

    if (!lista || lista.length === 0) {
        contenedor.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:40px; color:#666;"><h4>No hay productos disponibles.</h4></div>';
        return;
    }

    const html = lista.map(item => {
        const esAgotado = item.estado === 'agotado';
        const claseAgotado = esAgotado ? 'agotado' : '';
        
        let badgeHTML = '';
        if (esAgotado) {
            badgeHTML = `<span class="badge-agotado">AGOTADO</span>`;
        } else if (item.destacado) {
            badgeHTML = `<span class="badge-destacado">👑 TOP</span>`;
        }

        const img = escapeHtml(item.imagen_url || 'https://via.placeholder.com/300');
        const nombre = escapeHtml(item.nombre);
        const rating = item.ratingPromedio ? `★ ${escapeHtml(item.ratingPromedio)}` : '';
        const accionClick = esAgotado ? '' : `onclick="abrirDetalle(${Number(item.id)})"`;

        return `
            <div class="card ${claseAgotado}" ${accionClick}>
                ${badgeHTML}
                <div class="img-box"><img src="${img}" loading="lazy" alt="${nombre}"></div>
                <div class="info">
                    <h3>${nombre}</h3>
                    <p class="short-desc">${escapeHtml(item.descripcion)}</p>
                    <div class="card-footer">
                         <span class="price">${formatoPrecio(item.precio)}</span>
                         <span class="rating-pill">${rating}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    contenedor.innerHTML = html;
}

// 3. DETALLE
function abrirDetalle(id) {
    productoActual = todosLosProductos.find(p => p.id === id);
    if (!productoActual) return;

    const imgEl = document.getElementById('det-img');
    const box = document.getElementById('box-curiosidad');
    
    if(imgEl) imgEl.src = productoActual.imagen_url || '';
    setText('det-titulo', productoActual.nombre);
    setText('det-desc', productoActual.descripcion);
    setText('det-precio', formatoPrecio(productoActual.precio));
    
    const ratingBig = productoActual.ratingPromedio ? `★ ${productoActual.ratingPromedio}` : '★ --';
    setText('det-rating-big', ratingBig);

    if (productoActual.curiosidad && productoActual.curiosidad.length > 5) {
        if(box) box.style.display = "block";
        setText('det-curiosidad', productoActual.curiosidad);
    } else {
        if(box) box.style.display = "none";
    }

    // Botón "Agregar al pedido" solo si la carta se abrió desde el QR de una mesa
    cantidadDetalle = 1;
    setText('det-cantidad', cantidadDetalle);
    const boxAgregar = document.getElementById('box-agregar');
    if (boxAgregar) boxAgregar.style.display = mesaToken ? 'flex' : 'none';

    const modal = document.getElementById('modal-detalle');
    if(modal) {
        modal.style.display = 'flex';
        void modal.offsetWidth; 
        modal.classList.add('active');
    }
}

function setText(id, text) {
    const el = document.getElementById(id);
    if(el) el.textContent = text;
}

function cerrarDetalle() {
    const modal = document.getElementById('modal-detalle');
    if(modal) {
        modal.classList.remove('active');
        setTimeout(() => {
            modal.style.display = 'none';
        }, 300);
    }
}

// 4. OPINIONES
function abrirOpinionDesdeDetalle() {
    const modalDetalle = document.getElementById('modal-detalle');
    const modalOpinion = document.getElementById('modal-opinion');
    
    modalDetalle.classList.remove('active');
    setTimeout(() => {
        modalDetalle.style.display = 'none';
        modalOpinion.style.display = 'flex';
        void modalOpinion.offsetWidth;
        modalOpinion.classList.add('active');
        puntuacion = 0;
        actualizarEstrellas();
    }, 300);
}

function cerrarModalOpiniones() {
    const modal = document.getElementById('modal-opinion');
    if(modal) {
        modal.classList.remove('active');
        setTimeout(() => {
            modal.style.display = 'none';
        }, 300);
    }
}

const starsContainer = document.getElementById('stars-container');
if(starsContainer) {
    starsContainer.addEventListener('click', (e) => {
        if (e.target.tagName === 'SPAN') {
            puntuacion = parseInt(e.target.dataset.val);
            actualizarEstrellas();
        }
    });
}

function actualizarEstrellas() {
    document.querySelectorAll('#stars-container span').forEach(s => {
        const val = parseInt(s.dataset.val);
        s.style.color = val <= puntuacion ? 'var(--gold)' : '#444';
        s.textContent = val <= puntuacion ? '★' : '☆';
    });
}

async function enviarOpinion() {
    if (puntuacion === 0) { alert("¡Puntúa con estrellas!"); return; }
    
    const nombre = document.getElementById('cliente-nombre').value || "Anónimo";
    const comentario = document.getElementById('cliente-comentario').value;
    const btn = document.querySelector('#modal-opinion .btn-big-action');

    if(btn) { btn.textContent = "Enviando..."; btn.disabled = true; }

    const { error } = await supabaseClient.from('opiniones').insert([{
        producto_id: productoActual.id,
        cliente_nombre: nombre,
        comentario: comentario,
        puntuacion: puntuacion
    }]);

    if (!error) {
        showToast("¡Gracias! Tu opinión ha sido registrada.", "success");
        cerrarModalOpiniones();
        document.getElementById('cliente-comentario').value = "";
        cargarMenu(); 
    } else {
        showToast("Error: " + error.message, "error");
    }
    if(btn) { btn.textContent = "ENVIAR"; btn.disabled = false; }
}

// 5. FILTROS Y BÚSQUEDA (la categoría y el texto buscado se combinan)
function renderizarFiltros() {
    const nav = document.getElementById('filtros-carta');
    if (!nav) return;
    const botones = [`<button class="filter-btn ${categoriaActiva === 'todos' ? 'active' : ''}" onclick="filtrar('todos')">⭐ Todo</button>`]
        .concat(categoriasCarta.map(c => {
            const id = Number(c.id);
            return `<button class="filter-btn ${categoriaActiva === id ? 'active' : ''}" onclick="filtrar(${id})">${escapeHtml(etiquetaCategoria(c))}</button>`;
        }));
    nav.innerHTML = botones.join('');
}

function aplicarFiltros() {
    const searchInput = document.getElementById('search-input');
    const term = searchInput ? searchInput.value.toLowerCase() : '';
    const lista = todosLosProductos.filter(p =>
        (categoriaActiva === 'todos' || p.categoria_id === categoriaActiva) &&
        (p.nombre.toLowerCase().includes(term) || (p.descripcion && p.descripcion.toLowerCase().includes(term)))
    );
    renderizarMenu(lista);
}

function filtrar(cat) {
    categoriaActiva = cat;
    renderizarFiltros();
    aplicarFiltros();
}

const searchInput = document.getElementById('search-input');
if(searchInput) {
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(aplicarFiltros, 300);
    });
}

// 6. PEDIDO DEL CLIENTE (solo si la carta se abrió desde el QR de una mesa: index.html?mesa=<token>)
let mesaToken = null;
let carrito = [];        // [{ id, nombre, precio, cantidad }]
let cantidadDetalle = 1;

async function iniciarMesa() {
    const token = new URLSearchParams(window.location.search).get('mesa');
    if (!token) return;

    const { data: nombreMesa, error } = await supabaseClient.rpc('mesa_por_token', { p_token: token });
    if (error || !nombreMesa) {
        showToast("Este código QR no es válido. Pide ayuda al mozo.", "error");
        return;
    }

    mesaToken = token;
    const banner = document.getElementById('mesa-banner');
    banner.textContent = `📍 ${nombreMesa} · Elige tus productos y envía tu pedido`;
    banner.style.display = 'block';
    setText('carrito-mesa', nombreMesa);

    carrito = leerCarrito();
    actualizarCarritoUI();
}

// El carrito se guarda en la pestaña por si el cliente recarga la página
function leerCarrito() {
    try { return JSON.parse(sessionStorage.getItem(`carrito-${mesaToken}`)) || []; }
    catch (e) { return []; }
}

function guardarCarrito() {
    try { sessionStorage.setItem(`carrito-${mesaToken}`, JSON.stringify(carrito)); }
    catch (e) { /* sin almacenamiento: el carrito vive solo en memoria */ }
}

function totalCarrito() {
    return carrito.reduce((suma, item) => suma + item.precio * item.cantidad, 0);
}

function actualizarCarritoUI() {
    const fab = document.getElementById('cart-fab');
    const unidades = carrito.reduce((suma, item) => suma + item.cantidad, 0);
    fab.style.display = unidades > 0 ? 'flex' : 'none';
    setText('cart-resumen', `${unidades} · ${formatoPrecio(totalCarrito())}`);
}

function cambiarCantidadDetalle(delta) {
    cantidadDetalle = Math.max(1, Math.min(20, cantidadDetalle + delta));
    setText('det-cantidad', cantidadDetalle);
}

function agregarAlCarrito() {
    if (!productoActual || !mesaToken) return;
    const existente = carrito.find(item => item.id === productoActual.id);
    if (existente) {
        existente.cantidad = Math.min(50, existente.cantidad + cantidadDetalle);
    } else {
        carrito.push({ id: productoActual.id, nombre: productoActual.nombre, precio: Number(productoActual.precio), cantidad: cantidadDetalle });
    }
    guardarCarrito();
    actualizarCarritoUI();
    cerrarDetalle();
    showToast(`Agregado: ${cantidadDetalle} × ${productoActual.nombre}`, "success");
}

function abrirCarrito() {
    renderCarrito();
    abrirModal('modal-carrito');
}

function renderCarrito() {
    const contenedor = document.getElementById('carrito-items');
    if (carrito.length === 0) {
        contenedor.innerHTML = '<div class="vacio">Tu pedido está vacío</div>';
    } else {
        contenedor.innerHTML = carrito.map((item, indice) => `
            <div class="producto-fila">
                <div class="info-prod">
                    <span class="nombre-prod">${escapeHtml(item.nombre)}</span>
                    <span class="precio-prod">${formatoPrecio(item.precio * item.cantidad)}</span>
                </div>
                <div class="qty-control">
                    <button onclick="cambiarCantidadCarrito(${indice}, -1)">−</button>
                    <span class="qty">${Number(item.cantidad)}</span>
                    <button onclick="cambiarCantidadCarrito(${indice}, 1)">+</button>
                </div>
            </div>`).join('');
    }
    setText('carrito-total', formatoPrecio(totalCarrito()));
    document.getElementById('btn-enviar-carrito').disabled = carrito.length === 0;
}

function cambiarCantidadCarrito(indice, delta) {
    const item = carrito[indice];
    if (!item) return;
    item.cantidad = Math.min(50, item.cantidad + delta);
    if (item.cantidad <= 0) carrito.splice(indice, 1);
    guardarCarrito();
    actualizarCarritoUI();
    renderCarrito();
    if (carrito.length === 0) cerrarModal('modal-carrito');
}

async function enviarPedidoCliente(btn) {
    if (carrito.length === 0) return;
    btn.disabled = true;
    btn.textContent = "Enviando...";

    // El precio final lo pone la base de datos; aquí solo van productos y cantidades
    const { error } = await supabaseClient.rpc('crear_pedido_cliente', {
        p_mesa_token: mesaToken,
        p_items: carrito.map(item => ({ producto_id: item.id, cantidad: item.cantidad })),
        p_nota: document.getElementById('carrito-nota').value
    });

    btn.disabled = false;
    btn.textContent = "ENVIAR PEDIDO";

    if (error) {
        showToast(error.message, "error");
        if (error.message.includes('disponible')) cargarMenu();
        return;
    }

    carrito = [];
    guardarCarrito();
    actualizarCarritoUI();
    document.getElementById('carrito-nota').value = '';
    cerrarModal('modal-carrito');
    showToast("¡Pedido enviado! Un mozo lo confirmará en breve.", "success");
}

// INICIALIZACIÓN
document.addEventListener('DOMContentLoaded', cargarMenu);
document.addEventListener('DOMContentLoaded', iniciarMesa);

// TOASTS
function showToast(mensaje, tipo = 'success') {
    const container = document.getElementById('toast-container');
    if(!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${tipo}`;
    const icono = tipo === 'success' ? '✨' : '⚠️';
    toast.innerHTML = `<span class="toast-icon">${icono}</span><span class="toast-msg">${escapeHtml(mensaje)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.4s forwards';
        setTimeout(() => toast.remove(), 400);
    }, 3000);
}















