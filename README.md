# Intercomunicador de Imagenología

Intercomunicador web para salas compartidas. No crea cuentas para el personal: cada **navegador activado** es un terminal asociado a una sala. El servidor determina la sala de origen; la página no puede modificarla.

## Qué cambió

- Se eliminó el Broadcast público y los mensajes efímeros.
- Los avisos se guardan, se pueden confirmar y cerrar.
- La sala del terminal se asocia mediante un código de un solo uso, con vencimiento.
- Supabase Auth crea una identidad anónima persistente por navegador, sin correo ni datos de funcionarios.
- Las reglas RLS impiden que un terminal lea o publique como otra sala.
- Los canales Realtime son privados y cada terminal se une únicamente a su canal.
- La interfaz usa `textContent` para todos los avisos recibidos, evitando inyección HTML/XSS.

> No escribas nombres, RUT, diagnósticos ni otros datos identificables de pacientes en los avisos. Este intercomunicador debe transportar coordinación operativa mínima.

## Puesta en marcha (una vez)

Se requiere acceso de administrador al proyecto Supabase; los computadores clínicos solo necesitan abrir la web.

1. En **Authentication > Providers**, habilita **Anonymous sign-ins**.
2. En **SQL Editor**, ejecuta completo [`supabase/schema.sql`](supabase/schema.sql).
3. En **Realtime > Settings**, desactiva `Allow public access to channels`. Esto fuerza los canales privados definidos en el SQL.
4. En **Connect**, copia la clave `sb_publishable_...` y reemplaza la clave de `config.js`. La clave heredada funciona temporalmente, pero las claves `anon` se retiran progresivamente; conviene usar la publishable actual.
5. Publica estos archivos en un sitio HTTPS. No hay servidor ni instalación que hacer en los computadores de sala.

## Activar un terminal

Desde SQL Editor, genera un código de un solo uso. El resultado se muestra una única vez:

```sql
select public.create_activation_code('RAYOS_3', 'Rayos 3 · PC principal');
```

El código tendrá el formato `ABCD-EFGH-JKMP-QRST`: 16 caracteres, agrupados para anotarlo y transcribirlo con facilidad. No usa `I`, `L`, `O` ni `U`, para evitar confusiones. Los guiones son opcionales al ingresarlo. Abre la página en el computador de Rayos 3 e introduce ese código. La asociación queda guardada en el navegador. Repite el proceso por sala.

> Al ejecutar la actualización, los códigos largos que ya se hubieran creado seguirán siendo válidos hasta su vencimiento.

Para desactivar un computador perdido, reemplazado o que se usó indebidamente, localízalo por etiqueta y revócalo:

```sql
update public.terminals
set active = false, deactivated_at = now()
where label = 'Rayos 3 · PC principal' and active = true;
```

Después genera un nuevo código y activa el navegador de reemplazo. Si se borran los datos del navegador, el terminal pierde su identidad y debe activarse de nuevo.

## Reglas operativas

- Todos los terminales pueden dirigir un aviso a una sala concreta.
- Solo `Thalamus` puede elegir “Todas las salas”; esa regla se valida en PostgreSQL, no solo en la pantalla.
- El terminal receptor puede confirmar recepción; el terminal emisor puede cerrar el aviso.
- El botón de sonido se habilita una vez por navegador, porque los navegadores bloquean audio automático hasta que una persona interactúa.

## Verificación antes de uso

1. Activa dos navegadores con salas distintas.
2. Envía un aviso de uno al otro y confirma que llega, suena tras habilitar sonido y puede marcarse como recibido.
3. Recarga el receptor y comprueba que el aviso sigue visible.
4. Intenta seleccionar “Todas las salas” desde una sala distinta a Thalamus: debe ser rechazado por el servidor.
5. Desactiva un terminal, recarga la página correspondiente y verifica que ya no puede operar.

## Archivos

- `index.html`: interfaz web estática.
- `app.js`: sesión anónima, activación, avisos y sonido.
- `config.js`: URL y clave pública de Supabase.
- `supabase/schema.sql`: esquema, funciones, RLS y configuración Realtime.
