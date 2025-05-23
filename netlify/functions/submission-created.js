// netlify/functions/submission-created.js

// Base64 se puede requerir de forma síncrona ya que es CommonJS y pequeño.
const { Base64 } = require("js-base64");

// Constantes de configuración obtenidas de variables de entorno
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GITHUB_REPO_OWNER;
const REPO_NAME = process.env.GITHUB_REPO_NAME;
const REPO_BRANCH = process.env.GITHUB_REPO_BRANCH || "main"; // Rama principal donde se hará el PR
const FORM_NAME_PREFIX = process.env.NETLIFY_FORM_NAME_PREFIX || "comments-";

exports.handler = async (event) => {
  // Log inicial para confirmar que la función es invocada
  console.log(">>> submission-created handler INVOCADO <<<");
  console.log("Método HTTP:", event.httpMethod);

  // Verificar variables de entorno críticas (sin loguear el token en sí)
  if (!GITHUB_TOKEN) {
    console.error("ERROR CRÍTICO: GITHUB_TOKEN no está configurado.");
    return { statusCode: 500, body: "Configuración del servidor incompleta (GITHUB_TOKEN)." };
  }
  if (!REPO_OWNER || !REPO_NAME) {
    console.error("ERROR CRÍTICO: GITHUB_REPO_OWNER o GITHUB_REPO_NAME no están configurados.");
    return { statusCode: 500, body: "Configuración del servidor incompleta (REPO_OWNER/NAME)." };
  }
  console.log("Variables de entorno básicas (OWNER, NAME, BRANCH, PREFIX) parecen estar presentes.");
  console.log(`REPO_OWNER: ${REPO_OWNER}, REPO_NAME: ${REPO_NAME}, REPO_BRANCH: ${REPO_BRANCH}, FORM_NAME_PREFIX: ${FORM_NAME_PREFIX}`);


  // Validar método HTTP
  if (event.httpMethod !== "POST") {
    console.warn("Método HTTP no permitido:", event.httpMethod);
    return { statusCode: 405, body: "Method Not Allowed. Solo se permiten peticiones POST." };
  }
  console.log("Método HTTP es POST, continuando...");

  // Parsear el payload del evento
  let payload;
  try {
    // El payload de Netlify para "submission-created" está directamente en event.body
    // y ya es un objeto si la submission fue JSON, o necesita parseo si fue form-urlencoded
    // Para form submissions, event.body es una string.
    // Si tu formulario envía JSON directamente en el body:
    // payload = JSON.parse(event.body).payload;
    // Para 'submission-created' el payload relevante está anidado:
    if (typeof event.body === 'string') {
        payload = JSON.parse(event.body).payload;
    } else {
        payload = event.body.payload; // Si ya viene parseado por alguna razón
    }
    console.log("Payload parseado exitosamente.");
    // console.log("Payload completo:", JSON.stringify(payload, null, 2)); // Descomentar para debugging detallado del payload
  } catch (error) {
    console.error("Error parseando el cuerpo del evento (event.body):", error);
    console.error("event.body recibido:", event.body); // Loguear el body para inspección
    return { statusCode: 400, body: "Cuerpo de la petición malformado." };
  }

  // Extraer datos del payload
  const { data: formData, form_name, id: submissionId } = payload;
  console.log(`Formulario recibido: ${form_name}, ID de submission: ${submissionId}`);

  // Validar nombre del formulario
  if (!form_name || !form_name.startsWith(FORM_NAME_PREFIX)) {
    console.log(`Nombre del formulario "${form_name}" no coincide con el prefijo "${FORM_NAME_PREFIX}". Se omite.`);
    return {
      statusCode: 200, // OK, pero no se procesa
      body: JSON.stringify({ message: `Formulario "${form_name}" no es un formulario de comentarios. Envío omitido.` }),
    };
  }
  console.log("Nombre del formulario validado, es un formulario de comentarios.");

  // Extraer campos del formulario
  const { name, comment, article_slug, article_title, email, "bot-field": botField } = formData;

  // Validar campos
  if (botField) {
    console.warn("Detección de bot (campo honeypot llenado).");
    return { statusCode: 400, body: JSON.stringify({ error: "Envío de spam detectado." }) };
  }
  if (!name || !comment || !article_slug || !article_title) {
    const missing = [
      !name && "name",
      !comment && "comment",
      !article_slug && "article_slug",
      !article_title && "article_title",
    ].filter(Boolean).join(", ");
    console.error("Faltan campos requeridos:", missing, "Datos recibidos:", JSON.stringify(formData));
    return { statusCode: 400, body: JSON.stringify({ error: `Faltan campos requeridos: ${missing}` }) };
  }
  if (comment.length > 2000) {
    console.warn("Comentario demasiado largo:", comment.length, "caracteres.");
    return { statusCode: 400, body: JSON.stringify({ error: "El comentario es demasiado largo (máx 2000 caracteres)." }) };
  }
  console.log("Validaciones de campos del formulario pasadas.");

  // Preparar datos del comentario
  const commentData = {
    id: submissionId || Date.now().toString(), // Usar submissionId si está disponible, sino generar uno.
    name: name.trim(),
    comment: comment.trim(),
    date: new Date().toISOString(),
    article_slug: article_slug, // Guardar slug para referencia
    article_title: article_title, // Guardar título para referencia
  };
  console.log("Datos del comentario preparados:", JSON.stringify(commentData, null, 2));

  // Definir ruta del archivo de comentarios y nombre de la nueva rama
  const commentsFilePath = `_data/comments/${article_slug}.json`;
  const sanitizedSlug = String(article_slug).replace(/[^a-z0-9_-]/gi, "-"); // Permitir guiones bajos y medios
  const newBranchName = `comment-${sanitizedSlug}-${commentData.id}`;
  console.log(`Ruta del archivo de comentarios: ${commentsFilePath}`);
  console.log(`Nombre de la nueva rama a crear: ${newBranchName}`);

  let octokit;
  try {
    console.log("Intentando importar Octokit dinámicamente...");
    const octokitModule = await import("@octokit/rest");
    console.log("Módulo Octokit importado:", typeof octokitModule);
    if (!octokitModule || !octokitModule.Octokit) {
        console.error("ERROR: La importación de Octokit no devolvió la clase Octokit esperada.");
        return { statusCode: 500, body: "Error interno al cargar la librería de GitHub." };
    }
    octokit = new octokitModule.Octokit({ auth: GITHUB_TOKEN });
    console.log("Instancia de Octokit creada exitosamente.");

    // --- Lógica de GitHub ---
    console.log(`Obteniendo SHA de la rama base: ${REPO_BRANCH}...`);
    const { data: baseBranchRef } = await octokit.git.getRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `heads/${REPO_BRANCH}`,
    });
    const baseBranchSha = baseBranchRef.object.sha;
    console.log(`SHA de la rama ${REPO_BRANCH} obtenido: ${baseBranchSha}`);

    console.log(`Creando nueva rama "${newBranchName}" desde ${REPO_BRANCH}...`);
    await octokit.git.createRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `refs/heads/${newBranchName}`,
      sha: baseBranchSha,
    });
    console.log(`Rama "${newBranchName}" creada exitosamente.`);

    let existingComments = [];
    let existingFileSha = null;
    try {
      console.log(`Intentando obtener contenido de "${commentsFilePath}" en la rama "${newBranchName}"...`);
      const { data: fileData } = await octokit.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: commentsFilePath,
        ref: newBranchName, // Leer de la nueva rama
      });
      if (fileData && fileData.content) {
        existingComments = JSON.parse(Base64.decode(fileData.content));
        existingFileSha = fileData.sha;
        console.log(`Archivo "${commentsFilePath}" encontrado en "${newBranchName}". SHA: ${existingFileSha}. Comentarios existentes: ${existingComments.length}`);
      }
    } catch (error) {
      if (error.status === 404) {
        console.log(`Archivo "${commentsFilePath}" no encontrado en "${newBranchName}". Se creará uno nuevo.`);
      } else {
        console.error(`Error obteniendo contenido de "${commentsFilePath}" en "${newBranchName}":`, error.status, error.message);
        throw error; // Re-lanzar para que sea capturado por el catch principal
      }
    }

    const updatedComments = [...existingComments, commentData];
    const commitMessage = `feat: Nuevo comentario en "${article_title}" (ID: ${commentData.id})`;
    console.log("Comentarios actualizados. Total:", updatedComments.length);

    console.log(`Creando/Actualizando archivo "${commentsFilePath}" en la rama "${newBranchName}"...`);
    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: commentsFilePath,
      message: commitMessage,
      content: Base64.encode(JSON.stringify(updatedComments, null, 2)),
      sha: existingFileSha, // Proporcionar SHA si el archivo existe, sino se crea
      branch: newBranchName,
      committer: { name: "Netlify Comments Bot", email: "netlify-bot@example.com" }, // Puedes cambiar esto
      author: { name: name || "Usuario Anónimo", email: email || "netlify-bot@example.com" }, // Usar el email del usuario o uno genérico
    });
    console.log(`Archivo "${commentsFilePath}" actualizado/creado en "${newBranchName}".`);

    const prTitle = `Nuevo Comentario: ${article_title} por ${name}`;
    const prBody = `
Nuevo comentario enviado para el artículo: **${article_title}** (slug: \`${article_slug}\`)
Por: **${name}**
Email del usuario (para referencia administrativa, no se publica): ${email || 'No proporcionado'}
ID del Comentario: \`${commentData.id}\`
ID de Submission de Netlify: \`${submissionId || 'N/A'}\`

---
**Comentario:**
> ${comment}
---

Por favor, revisa y fusiona si es apropiado.
Esta PR fusionará la rama \`${newBranchName}\` en \`${REPO_BRANCH}\`.
`;
    console.log(`Creando Pull Request desde "${newBranchName}" hacia "${REPO_BRANCH}"...`);
    const { data: pullRequest } = await octokit.pulls.create({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      title: prTitle,
      head: newBranchName,  // La rama con los nuevos cambios
      base: REPO_BRANCH,    // La rama destino (ej. "main")
      body: prBody,
      maintainer_can_modify: true, // Opcional
    });
    console.log(`Pull Request creado exitosamente: ${pullRequest.html_url}`);

    return {
      statusCode: 201, // 201 Created es más apropiado para un PR creado
      body: JSON.stringify({
        message: "Comentario enviado para moderación. ¡Gracias!",
        pull_request_url: pullRequest.html_url,
      }),
    };

  } catch (error) {
    console.error("ERROR DURANTE EL PROCESAMIENTO DE GITHUB:", error.message);
    if (error.stack) console.error("Stacktrace:", error.stack);
    if (error.response && error.response.data) { // Errores de la API de GitHub
        console.error("Detalle del error de API de GitHub:", JSON.stringify(error.response.data, null, 2));
    }

    // Intento de limpiar la rama si se creó y algo falló después
    if (newBranchName && octokit) { // Solo si newBranchName está definido y octokit inicializado
        try {
            console.warn(`Error ocurrido. Intentando limpiar la rama "${newBranchName}"...`);
            await octokit.git.deleteRef({
                owner: REPO_OWNER,
                repo: REPO_NAME,
                ref: `heads/${newBranchName}`,
            });
            console.log(`Rama "${newBranchName}" eliminada exitosamente tras error.`);
        } catch (cleanupError) {
            console.error(`FALLO AL LIMPIAR la rama "${newBranchName}":`, cleanupError.message);
        }
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Error procesando el comentario: ${error.message}` }),
    };
  }
};
