-- =====================================================================
-- Demo Bar — Datos de ejemplo (opcional) — precios en guaraníes
-- Usa las imágenes de la carpeta img/ del repo (rutas relativas),
-- así la carta se ve completa sin subir nada a Storage.
-- Ejecutar después de schema.sql. Solo inserta si la tabla está vacía.
-- =====================================================================

insert into public.productos (nombre, precio, categoria_id, descripcion, curiosidad, imagen_url, destacado)
select v.nombre, v.precio, c.id, v.descripcion, v.curiosidad, v.imagen_url, v.destacado from (values
    -- Cocteles
    ('Mojito',            35000, 'Cocteles', 'Ron blanco, hierbabuena fresca, lima, azúcar y soda.', 'Era el cóctel favorito de Hemingway en La Bodeguita del Medio.', 'img/mojito.avif', true),
    ('Daiquiri',          35000, 'Cocteles', 'Ron, jugo de lima y azúcar, batido con hielo.', 'Nació en las minas de Daiquirí, en el oriente de Cuba.', 'img/daiquiri.avif', false),
    ('Cuba Libre',        30000, 'Cocteles', 'Ron, cola y un toque de lima.', 'Su nombre celebra la independencia de Cuba en 1898.', 'img/cuba-libre.webp', false),
    ('Piña Colada',       38000, 'Cocteles', 'Ron, crema de coco y jugo de piña.', 'Es la bebida oficial de Puerto Rico desde 1978.', 'img/piña-colada.webp', true),
    ('Gin Tonic',         45000, 'Cocteles', 'Ginebra premium, tónica y botánicos.', 'La tónica se creó para tomar quinina contra la malaria.', 'img/gin-tonic.webp', false),
    ('Michelada',         30000, 'Cocteles', 'Cerveza, lima, salsas y borde de sal picante.', null, 'img/michelada.jpg', false),
    -- Cervezas
    ('Cerveza Cristal',   15000, 'Cervezas', 'Lager cubana, ligera y refrescante.', null, 'img/cerveza-cristal.webp', false),
    ('Cerveza Bucanero',  15000, 'Cervezas', 'Lager cubana de cuerpo fuerte.', null, 'img/cerveza-bucanero.avif', false),
    ('Cerveza Importada', 25000, 'Cervezas', 'Selección de cervezas internacionales.', null, 'img/cerveza-importada.jpg', false),
    ('Cerveza de Barril', 18000, 'Cervezas', 'Tirada al momento, bien fría.', null, 'img/cerveza2.avif', false),
    -- Vinos y licores
    ('Havana Club 7 Años', 50000, 'Vinos y licores', 'Ron añejo cubano, servido solo o en las rocas.', 'Se añeja en barricas de roble blanco.', 'img/Havana-club7.webp', true),
    ('Copa de Vino Tinto', 30000, 'Vinos y licores', 'Tinto de la casa, afrutado y suave.', null, 'img/vino-tinto.jpg', false),
    -- Bebidas sin alcohol
    ('Jugo Natural',      15000, 'Sin alcohol', 'Fruta de temporada recién exprimida.', null, 'img/jugo-natural.jpg', false),
    ('Limonada',          15000, 'Sin alcohol', 'Limón natural con hierbabuena.', null, 'img/limonada.jpg', false),
    ('Batido de Chocolate', 22000, 'Sin alcohol', 'Batido cremoso de chocolate.', null, 'img/batido-chocolate.avif', false),
    ('Jugo de Piña',      15000, 'Sin alcohol', 'Piña natural colada.', null, 'img/pina.webp', false),
    -- Pizzas y pastas
    ('Pizza de Jamón',    55000, 'Pizzas y pastas', 'Salsa de tomate, mozzarella y jamón.', null, 'img/pizza-jamon.jpg', false),
    ('Pizza Pepperoni',   60000, 'Pizzas y pastas', 'Mozzarella y pepperoni crujiente.', 'El pepperoni es un invento ítalo-estadounidense.', 'img/pizza-peperoni.jpg', true),
    ('Spaghetti Carbonara', 55000, 'Pizzas y pastas', 'Huevo, queso pecorino, panceta y pimienta negra.', 'La receta original no lleva crema.', 'img/spaguetti-carbonara.avif', false),
    -- Platos fuertes
    ('Ropa Vieja',        65000, 'Platos fuertes', 'Carne de res deshilachada en salsa criolla con arroz.', 'Uno de los platos nacionales de Cuba.', 'img/ropa-vieja.webp', true),
    ('Bistec de Cerdo',   60000, 'Platos fuertes', 'Bistec a la plancha con mojo y guarnición.', null, 'img/bistec-cerdo.avif', false),
    ('Fajitas de Pollo',  62000, 'Platos fuertes', 'Pollo salteado con pimientos y cebolla, con tortillas.', null, 'img/fajitas-pollo.jpg', false),
    -- Para picar
    ('Tostones',          25000, 'Para picar', 'Plátano verde frito, aplastado y crujiente.', null, 'img/tostones.webp', false),
    ('Tostones Rellenos', 35000, 'Para picar', 'Tostones en forma de copa rellenos de picadillo.', null, 'img/tostones-rellenos.webp', false),
    ('Croquetas',         28000, 'Para picar', 'Croquetas caseras de jamón.', null, 'img/croqueta.webp', false),
    ('Tabla de Quesos',   80000, 'Para picar', 'Selección de quesos con frutos secos y mermelada.', null, 'img/tabla-quesos.jpg', false),
    ('Tabla Mixta',       95000, 'Para picar', 'Embutidos, quesos y aceitunas para compartir.', null, 'img/tabla.webp', false)
) as v(nombre, precio, categoria, descripcion, curiosidad, imagen_url, destacado)
join public.categorias c on c.nombre = v.categoria
where not exists (select 1 from public.productos);

-- Mesas de ejemplo (cada una con su token para el QR)
insert into public.mesas (nombre)
select v.nombre from (values
    ('Mesa 1'), ('Mesa 2'), ('Mesa 3'), ('Mesa 4'), ('Mesa 5'),
    ('Mesa 6'), ('Mesa 7'), ('Mesa 8'), ('Barra 1'), ('Barra 2')
) as v(nombre)
where not exists (select 1 from public.mesas);

-- Stock inicial para productos envasados (el resto queda sin control: stock = null)
update public.productos set stock = v.stock
from (values
    ('Cerveza Cristal', 48), ('Cerveza Bucanero', 48), ('Cerveza Importada', 24),
    ('Havana Club 7 Años', 6), ('Copa de Vino Tinto', 20), ('Croquetas', 40)
) as v(nombre, stock)
where productos.nombre = v.nombre and productos.stock is null;
