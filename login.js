// Supabase conserva contraseñas y roles; el alias es interno y no recibe correo.
function correoDeUsuario(usuario) {
    const nombre = String(usuario).trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(nombre)) throw new Error('Indica un usuario válido (3 a 40 caracteres).');
    return nombre + '@usuarios.mashbeer.invalid';
}

document.getElementById('login-form').addEventListener('submit', async evento => {
    evento.preventDefault();
    const boton = document.getElementById('btn-login');
    const aviso = document.getElementById('error-msg');
    if (boton.disabled) return;
    boton.disabled = true;
    boton.textContent = 'Verificando…';
    aviso.textContent = '';
    try {
        const email = correoDeUsuario(document.getElementById('usuario').value);
        const { error } = await supabaseClient.auth.signInWithPassword({
            email, password: document.getElementById('password').value
        });
        if (error) throw new Error('Usuario o contraseña incorrectos.');
        const rol = await obtenerRol();
        if (!rol) {
            await supabaseClient.auth.signOut();
            throw new Error('Tu usuario no tiene permisos. Contactá al administrador.');
        }
        window.location.href = paginaInicioPorRol(rol);
    } catch (error) {
        aviso.textContent = error.message || 'No se pudo iniciar sesión. Intentá nuevamente.';
    } finally {
        boton.disabled = false;
        boton.textContent = 'INICIAR SESIÓN';
    }
});
