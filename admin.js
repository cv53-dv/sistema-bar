// admin.js COMPLETO Y CORREGIDO

let inventarioGlobal = []; // Almacena los productos cargados para poder editarlos
let categoriasAdmin = [];  // Todas las categorías, en el orden de la carta

// 1. VERIFICACIÓN DE SEGURIDAD (solo administradores)
async function checkAuth() {
    if (typeof supabaseClient === 'undefined') {
        console.error("Supabase no está definido. Revisa config.js");
        return;
    }
    const rol = await requerirRol(['admin']);
    if (!rol) return;
    await cargarCategoriasAdmin();
    cargarAdmin();
}

// 2. CARGAR INVENTARIO
async function cargarAdmin() {
    const lista = document.getElementById('lista-admin');
    if (lista) lista.innerHTML = '<div style="text-align:center; padding:40px; color:#aaa;">⟳ Cargando inventario...</div>';

    // Traemos los productos activos
    let { data: productos, error } = await supabaseClient
        .from('productos')
        .select('*')
        .eq('activo', true)
        .order('id', { ascending: false });

    if (error) { 
        alert("Error al cargar: " + error.message); 
        return; 
    }
    
    // Guardamos en variable global para usar al editar
    inventarioGlobal = productos || [];
    renderCategorias(); // actualiza la cantidad de productos por categoría

    if (!productos || productos.length === 0) {
        if (lista) lista.innerHTML = '<p style="text-align:center; padding:20px; color:#888;">El inventario está vacío.<br><small>Añade tu primer producto a la izquierda.</small></p>';
        return;
    }

    const html = productos.map(item => {
        const esAgotado = item.estado === 'agotado';
        const statusText = esAgotado ? 'AGOTADO' : 'DISPONIBLE';
        const statusClass = esAgotado ? 'status-bad' : 'status-ok';
        const iconState = esAgotado ? 'toggle_off' : 'toggle_on';
        const colorStateBtn = esAgotado ? '#666' : 'var(--green-success)';
        const favColor = item.destacado ? 'var(--gold)' : '#444';
        const img = escapeHtml(item.imagen_url || 'https://via.placeholder.com/60');
        const id = Number(item.id);
        const estado = esAgotado ? 'agotado' : 'disponible';

        let stockHTML = '';
        if (item.stock !== null) {
            const claseStock = item.stock === 0 ? 'stock-cero' : (item.stock <= 5 ? 'stock-bajo' : '');
            stockHTML = `<span class="item-status ${claseStock}" style="background:#2a2a30; color:#aaa;">Stock: ${Number(item.stock)}</span>`;
        }

        return `
            <div class="inventory-item">
                <img src="${img}" class="item-thumb" alt="Imagen">

                <div class="item-meta">
                    <span class="item-title">
                        ${escapeHtml(item.nombre)} ${item.destacado ? '🌟' : ''}
                    </span>
                    <span class="item-categoria">${escapeHtml(nombreCategoria(item.categoria_id))}</span>
                    <span class="item-price">${formatoPrecio(item.precio)}</span>
                    <span class="item-status ${statusClass}">${statusText}</span>
                    ${stockHTML}
                </div>

                <div class="action-btn-group">
                    <button class="icon-btn" onclick="prepararEdicion(${id})" title="Editar" style="color:#fff;">
                        <span class="material-icons">edit</span>
                    </button>

                    <button class="icon-btn" onclick="reponerStock(${id})" title="Ingresar stock">
                        <span class="material-icons">add_box</span>
                    </button>

                    <button class="icon-btn" style="color:${favColor}" onclick="toggleDestacado(${id}, ${item.destacado === true})" title="Destacar">
                        <span class="material-icons">star</span>
                    </button>

                    <button class="icon-btn" style="color:${colorStateBtn}" onclick="toggleEstado(${id}, '${estado}')" title="Disponibilidad">
                        <span class="material-icons">${iconState}</span>
                    </button>

                    <button class="icon-btn btn-del" onclick="eliminarProducto(${id})" title="Eliminar">
                        <span class="material-icons">delete</span>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    if (lista) lista.innerHTML = html;
}

// 3. GENERAR CURIOSIDAD CON IA (CORREGIDO)
async function generarCuriosidad() {
    const nombre = document.getElementById('nombre').value;
    const campo = document.getElementById('curiosidad');
    const loader = document.getElementById('loader-ia');
    const btn = document.getElementById('btn-ia');

    if (!nombre) { alert("Por favor escribe el nombre del producto primero."); return; }

    btn.disabled = true; 
    loader.style.display = "inline-block"; 
    campo.value = "Generando...";

    const API_KEY = CONFIG.GEMINI_KEY; 
    // CORRECCIÓN: Usamos el modelo 'gemini-2.5-flash' que confirmamos que tienes disponible
    const URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;
    
    const prompt = `Escribe un dato curioso muy breve (máximo 20 palabras) y divertido sobre: "${nombre}". Tono gastronómico.`;

    try {
        const res = await fetch(URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await res.json();
        
        if (data.error) {
            console.error("Error API:", data.error);
            campo.value = "Error: " + data.error.message;
        } else if (data.candidates && data.candidates[0].content) {
            campo.value = data.candidates[0].content.parts[0].text;
        } else {
            campo.value = "No se pudo generar el dato.";
        }
    } catch (e) {
        console.error(e);
        campo.value = "Error de conexión.";
    } finally {
        loader.style.display = "none"; 
        btn.disabled = false;
    }
}

// 4. FUNCIONES DE EDICIÓN (NUEVAS)
function prepararEdicion(id) {
    const producto = inventarioGlobal.find(p => p.id === id);
    if (!producto) return;

    // Llenar inputs
    document.getElementById('edit-id').value = producto.id;
    document.getElementById('nombre').value = producto.nombre;
    document.getElementById('precio').value = producto.precio;
    document.getElementById('categoria').value = producto.categoria_id ?? '';
    document.getElementById('descripcion').value = producto.descripcion || '';
    document.getElementById('curiosidad').value = producto.curiosidad || '';
    document.getElementById('destacado').checked = producto.destacado;
    document.getElementById('stock').value = producto.stock ?? '';

    // Ajustar UI
    document.getElementById('btn-submit').textContent = "ACTUALIZAR PRODUCTO";
    document.getElementById('btn-cancelar').style.display = "block";
    
    // Ir arriba
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cancelarEdicion() {
    document.getElementById('form-producto').reset();
    document.getElementById('edit-id').value = ""; // Limpiar ID
    
    document.getElementById('btn-submit').textContent = "GUARDAR PRODUCTO";
    document.getElementById('btn-cancelar').style.display = "none";
}

// 5. GUARDAR O ACTUALIZAR PRODUCTO
const form = document.getElementById('form-producto');
if(form) {
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const btn = document.getElementById('btn-submit');
        const textoOriginal = btn.textContent;
        btn.textContent = "Procesando..."; 
        btn.disabled = true;

        try {
            // Recoger datos
            const idEdicion = document.getElementById('edit-id').value;
            const nombre = document.getElementById('nombre').value;
            const precio = document.getElementById('precio').value;
            const categoria_id = Number(document.getElementById('categoria').value);
            if (!categoria_id) throw new Error("Elige una categoría. Si no hay ninguna, créala abajo en Categorías.");
            const descripcion = document.getElementById('descripcion').value;
            const curiosidad = document.getElementById('curiosidad').value;
            const destacado = document.getElementById('destacado').checked;
            const stockTexto = document.getElementById('stock').value.trim();
            const stock = stockTexto === '' ? null : parseInt(stockTexto, 10);
            const fileInput = document.getElementById('imagen-file');

            let urlImagen = null;

            // --- Lógica de Imagen ---
            if (fileInput.files.length > 0) {
                const archivo = fileInput.files[0];
                const extension = archivo.name.split('.').pop();
                const nombreArchivo = `prod_${Date.now()}.${extension}`;

                const { error: upErr } = await supabaseClient.storage
                    .from('imagenes')
                    .upload(nombreArchivo, archivo);
                
                if (upErr) throw upErr;

                const { data: urlData } = supabaseClient.storage
                    .from('imagenes')
                    .getPublicUrl(nombreArchivo);
                
                urlImagen = urlData.publicUrl;
            } else {
                // Si es nuevo, la imagen es obligatoria
                if (!idEdicion) throw new Error("Debes subir una imagen para un producto nuevo.");
            }

            // Datos base
            const datos = {
                nombre,
                precio,
                categoria_id,
                descripcion,
                curiosidad, 
                destacado
            };

            // Solo actualizamos imagen si subieron una nueva
            if (urlImagen) {
                datos.imagen_url = urlImagen;
            }

            // El stock solo se envía si cambió: así no se pisan las ventas
            // que ocurrieron mientras el formulario estaba abierto
            const original = inventarioGlobal.find(p => String(p.id) === idEdicion);
            if (!idEdicion || !original || original.stock !== stock) {
                datos.stock = stock;
            }

            if (idEdicion) {
                // --- UPDATE (Editar) ---
                await actualizarProducto(idEdicion, datos);
            } else {
                // --- INSERT (Crear) ---
                datos.estado = 'disponible';
                datos.activo = true;
                const { error } = await supabaseClient
                    .from('productos')
                    .insert([datos]);
                if (error) throw error;
            }

            alert(idEdicion ? "¡Producto actualizado!" : "¡Producto creado!");
            cancelarEdicion(); // Resetea form y botones
            cargarAdmin(); // Recarga lista

        } catch (error) {
            alert("Error: " + error.message);
        } finally {
            btn.textContent = textoOriginal; 
            btn.disabled = false;
        }
    });
}

// 6. ACCIONES RÁPIDAS (Switch, Estrella, Borrar)

// Con RLS, un update sin permiso no devuelve error: simplemente no afecta filas.
// Pedimos las filas actualizadas para poder detectarlo.
async function actualizarProducto(id, cambios) {
    const { data, error } = await supabaseClient
        .from('productos')
        .update(cambios)
        .eq('id', id)
        .select('id');
    if (error) throw error;
    if (!data || data.length === 0) {
        throw new Error("No se aplicó el cambio. Verifica que tu usuario sea administrador.");
    }
}

async function toggleDestacado(id, valorActual) {
    try {
        await actualizarProducto(id, { destacado: !valorActual });
        cargarAdmin();
    } catch (error) {
        alert("Error: " + error.message);
    }
}

async function toggleEstado(id, estadoActual) {
    const nuevoEstado = estadoActual === 'disponible' ? 'agotado' : 'disponible';
    try {
        await actualizarProducto(id, { estado: nuevoEstado });
        cargarAdmin();
    } catch (error) {
        alert("Error: " + error.message);
    }
}

// Ingreso de mercadería: suma unidades al stock actual
async function reponerStock(id) {
    const producto = inventarioGlobal.find(p => p.id === id);
    if (!producto) return;
    const actual = producto.stock === null ? 'sin control' : producto.stock;
    const texto = prompt(`¿Cuántas unidades de "${producto.nombre}" ingresan?\nStock actual: ${actual}`);
    if (texto === null) return;

    const cantidad = parseInt(texto, 10);
    if (isNaN(cantidad) || cantidad <= 0) { alert("Ingresa un número mayor a 0."); return; }

    try {
        const nuevoStock = await llamarRpc('reponer_stock', { p_producto_id: id, p_cantidad: cantidad });
        alert(`Stock actualizado: ${nuevoStock} unidades.`);
        cargarAdmin();
    } catch (error) {
        alert("Error: " + error.message);
    }
}

async function eliminarProducto(id) {
    if(confirm("¿Estás seguro de eliminar este producto?")) {
        try {
            await actualizarProducto(id, { activo: false });
            cargarAdmin();
        } catch (error) {
            alert("Error: " + error.message);
        }
    }
}

// 7. CATEGORÍAS
async function cargarCategoriasAdmin() {
    try {
        categoriasAdmin = await cargarCategorias();
    } catch (error) {
        mostrarAviso("Error al cargar categorías: " + error.message, 'error');
        return;
    }
    llenarSelectCategorias();
    renderCategorias();
}

function nombreCategoria(id) {
    const categoria = categoriasAdmin.find(c => c.id === id);
    return categoria ? etiquetaCategoria(categoria) : 'Sin categoría';
}

// Opciones del formulario de productos (conserva la elegida al recargar)
function llenarSelectCategorias() {
    const select = document.getElementById('categoria');
    const elegida = select.value;
    select.innerHTML = categoriasAdmin.length
        ? categoriasAdmin.map(c =>
            `<option value="${Number(c.id)}">${escapeHtml(etiquetaCategoria(c))}${c.visible ? '' : ' (oculta)'}</option>`).join('')
        : '<option value="">Primero crea una categoría</option>';
    if (categoriasAdmin.some(c => String(c.id) === elegida)) select.value = elegida;
}

function renderCategorias() {
    const lista = document.getElementById('lista-categorias');
    if (!lista) return;
    if (categoriasAdmin.length === 0) {
        lista.innerHTML = '<p class="vacio">No hay categorías. Crea la primera arriba.</p>';
        return;
    }

    lista.innerHTML = categoriasAdmin.map((c, i) => {
        const id = Number(c.id);
        const cantidad = inventarioGlobal.filter(p => p.categoria_id === c.id).length;
        return `
            <div class="categoria-fila ${c.visible ? '' : 'oculta'}">
                <div class="cat-info">
                    <span class="cat-nombre">${escapeHtml(etiquetaCategoria(c))}</span>
                    <span class="cat-cant">${cantidad} producto${cantidad === 1 ? '' : 's'}${c.visible ? '' : ' · oculta en la carta'}</span>
                </div>
                <div class="action-btn-group">
                    <button class="icon-btn" onclick="moverCategoria(${id}, -1)" title="Subir" ${i === 0 ? 'disabled' : ''}><span class="material-icons">arrow_upward</span></button>
                    <button class="icon-btn" onclick="moverCategoria(${id}, 1)" title="Bajar" ${i === categoriasAdmin.length - 1 ? 'disabled' : ''}><span class="material-icons">arrow_downward</span></button>
                    <button class="icon-btn" onclick="editarCategoria(${id})" title="Renombrar" style="color:#fff;"><span class="material-icons">edit</span></button>
                    <button class="icon-btn" onclick="cambiarVisibilidadCategoria(${id})" title="${c.visible ? 'Ocultar de la carta' : 'Mostrar en la carta'}" style="color:${c.visible ? 'var(--green-success)' : '#666'};"><span class="material-icons">${c.visible ? 'visibility' : 'visibility_off'}</span></button>
                    <button class="icon-btn btn-del" onclick="eliminarCategoria(${id})" title="Eliminar"><span class="material-icons">delete</span></button>
                </div>
            </div>`;
    }).join('');
}

async function guardarCategoria(evento) {
    evento.preventDefault();
    const idEdicion = Number(document.getElementById('categoria-edit-id').value);
    const nombre = document.getElementById('categoria-nombre').value.trim();
    const emoji = document.getElementById('categoria-emoji').value.trim();
    if (!nombre) return;

    const boton = document.getElementById('btn-categoria');
    boton.disabled = true;
    try {
        if (idEdicion) {
            const { data, error } = await supabaseClient.from('categorias')
                .update({ nombre, emoji }).eq('id', idEdicion).select('id');
            if (error) throw error;
            if (!data || data.length === 0) throw new Error("No se aplicó el cambio. Verifica que tu usuario sea administrador.");
        } else {
            const orden = categoriasAdmin.reduce((max, c) => Math.max(max, c.orden), 0) + 1;
            const { error } = await supabaseClient.from('categorias').insert([{ nombre, emoji, orden }]);
            if (error) throw error;
        }
        mostrarAviso(idEdicion ? "Categoría actualizada" : `Categoría "${nombre}" creada`);
        cancelarEdicionCategoria();
        await cargarCategoriasAdmin();
        cargarAdmin();
    } catch (error) {
        mostrarAviso(error.code === '23505' ? "Ya existe una categoría con ese nombre" : error.message, 'error');
    } finally {
        boton.disabled = false;
    }
}

function editarCategoria(id) {
    const categoria = categoriasAdmin.find(c => c.id === id);
    if (!categoria) return;
    document.getElementById('categoria-edit-id').value = categoria.id;
    document.getElementById('categoria-nombre').value = categoria.nombre;
    document.getElementById('categoria-emoji').value = categoria.emoji;
    document.getElementById('btn-categoria').textContent = "Guardar";
    document.getElementById('btn-categoria-cancelar').style.display = '';
    document.getElementById('categoria-nombre').focus();
}

function cancelarEdicionCategoria() {
    document.getElementById('categoria-edit-id').value = '';
    document.getElementById('categoria-nombre').value = '';
    document.getElementById('categoria-emoji').value = '';
    document.getElementById('btn-categoria').textContent = "Agregar";
    document.getElementById('btn-categoria-cancelar').style.display = 'none';
}

// Sube o baja una categoría: se guarda el orden completo de una vez
async function moverCategoria(id, delta) {
    const ids = categoriasAdmin.map(c => c.id);
    const desde = ids.indexOf(id);
    const hasta = desde + delta;
    if (desde < 0 || hasta < 0 || hasta >= ids.length) return;
    ids.splice(hasta, 0, ids.splice(desde, 1)[0]);

    try {
        await llamarRpc('ordenar_categorias', { p_ids: ids });
        await cargarCategoriasAdmin();
    } catch (error) {
        mostrarAviso(error.message, 'error');
    }
}

async function cambiarVisibilidadCategoria(id) {
    const categoria = categoriasAdmin.find(c => c.id === id);
    if (!categoria) return;
    try {
        const { data, error } = await supabaseClient.from('categorias')
            .update({ visible: !categoria.visible }).eq('id', id).select('id');
        if (error) throw error;
        if (!data || data.length === 0) throw new Error("No se aplicó el cambio. Verifica que tu usuario sea administrador.");
        mostrarAviso(categoria.visible ? `"${categoria.nombre}" ya no se muestra en la carta` : `"${categoria.nombre}" vuelve a mostrarse en la carta`);
        await cargarCategoriasAdmin();
        cargarAdmin();
    } catch (error) {
        mostrarAviso(error.message, 'error');
    }
}

async function eliminarCategoria(id) {
    const categoria = categoriasAdmin.find(c => c.id === id);
    if (!categoria) return;
    if (!confirm(`¿Eliminar la categoría "${categoria.nombre}"?`)) return;
    try {
        await llamarRpc('eliminar_categoria', { p_id: id });
        mostrarAviso("Categoría eliminada");
        await cargarCategoriasAdmin();
    } catch (error) {
        mostrarAviso(error.message, 'error');
    }
}

// Inicializar
document.addEventListener('DOMContentLoaded', checkAuth);