// netlify/functions/submission-created.js

const { Octokit } = require("@octokit/rest");
const { Base64 } = require("js-base64");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GITHUB_REPO_OWNER;
const REPO_NAME = process.env.GITHUB_REPO_NAME;
const REPO_BRANCH = process.env.GITHUB_REPO_BRANCH || "main";
const FORM_NAME_PREFIX = process.env.NETLIFY_FORM_NAME_PREFIX || "comments-";

// Inicializar Octokit globalmente
let octokit;
try {
  octokit = new Octokit({ auth: GITHUB_TOKEN });
} catch (initError) {
  console.error("Failed to initialize Octokit:", initError);
}

exports.handler = async (event) => {
  if (!octokit) {
    console.error("Octokit instance is not available. Aborting function.");
    return {
      statusCode: 500,
      body: "Internal server error: Could not initialize GitHub client.",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body).payload;
  } catch (error) {
    console.error("Error parsing event body:", error);
    return { statusCode: 400, body: "Malformed request body." };
  }
  
  const { data, form_name, id: submissionId } = payload;
  if (!form_name || !form_name.startsWith(FORM_NAME_PREFIX)) {
    console.log(`Form name "${form_name}" does not match prefix "${FORM_NAME_PREFIX}". Skipping.`);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: `Form "${form_name}" not a comment form. Submission skipped.` }),
    };
  }

  const { name, comment, article_slug, article_title, email, "bot-field": botField } = data;
  if (botField) {
    console.warn("Bot submission detected (honeypot filled).");
    return { statusCode: 400, body: JSON.stringify({ error: "Spam submission detected." }) };
  }
  if (!name || !comment || !article_slug || !article_title) {
    const missing = [
      !name && "name",
      !comment && "comment",
      !article_slug && "article_slug",
      !article_title && "article_title"
    ]
      .filter(Boolean)
      .join(", ");
    console.error("Missing required fields:", data);
    return { statusCode: 400, body: JSON.stringify({ error: `Missing required fields: ${missing}` }) };
  }
  if (comment.length > 2000) {
    return { statusCode: 400, body: JSON.stringify({ error: "Comment is too long (max 2000 chars)." }) };
  }

  const commentData = {
    id: Date.now().toString(),
    name: name.trim(),
    comment: comment.trim(),
    date: new Date().toISOString(),
  };

  const commentsFilePath = `_data/comments/${article_slug}.json`;
  // Saneamos el slug en caso de ser necesario (para un archivo con nombre válido)
  const sanitizedSlug = String(article_slug).replace(/[^a-z0-9]/gi, "-");

  // Ahora: actualizar el archivo directamente en la rama main
  try {
    // Obtener el contenido actual del archivo, usando la rama main
    let existingComments = [];
    let fileSha = null;
    try {
      const { data: fileData } = await octokit.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: commentsFilePath,
        ref: REPO_BRANCH, // Obtenemos desde la rama main
      });
      if (fileData.content) {
        existingComments = JSON.parse(Base64.decode(fileData.content));
        fileSha = fileData.sha;
      }
    } catch (error) {
      // Si el archivo no existe, se creará uno nuevo
      if (error.status !== 404) throw error;
      console.log(`Comments file "${commentsFilePath}" not found. Creating new one.`);
    }

    // Añadir el nuevo comentario a los existentes
    const updatedComments = [...existingComments, commentData];
    const commitMessage = `feat: Add new comment to ${article_title} (ID: ${commentData.id})`;

    // Actualizar o crear el archivo en la rama main
    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: commentsFilePath,
      message: commitMessage,
      content: Base64.encode(JSON.stringify(updatedComments, null, 2)),
      sha: fileSha, // Si no existe, omitir sha para crear el archivo
      branch: REPO_BRANCH, // Especificamos la rama main
      committer: { name: "Netlify Comments Bot", email: "netlify-bot@example.com" },
      author: { name: "Netlify Comments Bot", email: "netlify-bot@example.com" },
    });
    console.log(`Comments file "${commentsFilePath}" updated in branch "${REPO_BRANCH}".`);

    // En este flujo, no se crea una rama ni PR, ya que el archivo se actualiza directamente
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Comment submitted and file updated in main. Thank you!"
      }),
    };
  } catch (error) {
    console.error("Error processing comment submission:", error.message);
    if (error.stack) console.error(error.stack);
    if (error.response && error.response.data) {
      console.error("GitHub API Error:", error.response.data);
    }
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Error processing comment: ${error.message}` }),
    };
  }
};
