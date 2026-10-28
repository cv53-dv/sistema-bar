const CONFIG = {
    NOMBRE_BAR: 'MI BAR',   // aparece en tickets y comandas
    // Dirección que llevan los QR de las mesas (ej. 'https://mibar.com/').
    // Vacío = la dirección con la que se abrió la página de Caja.
    URL_PUBLICA: '',
    // Proyecto de Supabase en la nube (Project Settings → API Keys). Completar al publicar.
    SUPABASE_URL: 'https://TU-PROYECTO.supabase.co',
    SUPABASE_KEY: 'sb_publishable_TU_CLAVE',
    // Usamos el modelo más estable para evitar errores 404
    GEMINI_KEY: 'AIzaSyDDqPRUFilvcpVlFlMnxkYYju4RnVAFGv4' 
};

// En local (npx supabase start) usamos la base de datos de Docker de la misma PC.
// También desde el celular en la misma red WiFi (ej. http://192.168.x.x:8080).
const ES_RED_LOCAL = location.hostname === 'localhost'
    || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);

if (ES_RED_LOCAL) {
    CONFIG.SUPABASE_URL = `http://${location.hostname}:54321`;
    CONFIG.SUPABASE_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
    // IP de esta PC en la WiFi: los QR apuntan aquí aunque Caja se abra como localhost.
    // Si la PC cambia de red o de IP (ipconfig → "Dirección IPv4"), actualízala y reimprime los QR.
    CONFIG.URL_PUBLICA = 'http://192.168.127.125:8080/';
}

const supabaseClient = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);



