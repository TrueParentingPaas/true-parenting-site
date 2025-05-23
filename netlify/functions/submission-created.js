import { Octokit } from "@octokit/rest"; 
import { Base64 } from "js-base64";     

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GITHUB_REPO_OWNER;
const REPO_NAME = process.env.GITHUB_REPO_NAME;
const REPO_BRANCH = process.env.GITHUB_REPO_BRANCH || "main"; // Rama principal
const FORM_NAME_PREFIX = process.env.NETLIFY_FORM_NAME_PREFIX || "comments-";

const octokit = new Octokit({ auth: GITHUB_TOKEN });

exports.handler = async (event) => {
    if (!event.body) {
        return { statusCode: 400, body: "Event body is missing." };
    }

    let payload;
    try {
        payload = JSON.parse(event.body).payload;
    } catch (error) {
        console.error("Error parsing event body:", error);
        return { statusCode: 400, body: "Malformed request body." };
    }
    
    const { data, form_name, id: submissionId } = payload;

    // 1. Disparador (automático por el nombre del archivo)
    // Solo procesar formularios de comentarios
    if (!form_name || !form_name.startsWith(FORM_NAME_PREFIX)) {
        console.log(`Form name "${form_name}" does not match prefix "${FORM_NAME_PREFIX}". Skipping.`);
        return {
            statusCode: 200, // O 204 si prefieres no enviar cuerpo
            body: `Form "${form_name}" not a comment form. Submission skipped.`,
        };
    }

    // 2. Recepción y Análisis de Datos
    const { name, comment, article_slug, article_title, email, "bot-field": botField } = data;

    // 3. Validación Inicial (simple)
    if (botField) { // Honeypot
        console.warn("Bot submission detected (honeypot filled).");
        return { statusCode: 400, body: "Spam submission detected." };
    }
    if (!name || !comment || !article_slug || !article_title) {
        console.error("Missing required fields:", { name, comment, article_slug, article_title });
        return { statusCode: 400, body: "Missing required fields: name, comment, article_slug, article_title." };
    }
    if (comment.length > 2000) { // Límite de longitud
        return { statusCode: 400, body: "Comment is too long." };
    }

    const commentData = {
        id: Date.now().toString(), // ID único simple
        name: name.trim(),
        comment: comment.trim(),
        date: new Date().toISOString(),
        // NO GUARDAMOS EL EMAIL en el archivo JSON público
    };

    const commentsFilePath = `_data/comments/${article_slug}.json`;
    const newBranchName = `comment-${article_slug}-${commentData.id}`;

    try {
        // 4. Interacción con la API de Git (GitHub)

        // 4.a Autenticación (hecha al instanciar Octokit)

        // Obtener la referencia de la rama principal
        const { data: mainBranch } = await octokit.git.getRef({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            ref: `heads/${REPO_BRANCH}`,
        });
        const mainBranchSha = mainBranch.object.sha;

        // 4.e Crear una Nueva Rama
        await octokit.git.createRef({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            ref: `refs/heads/${newBranchName}`,
            sha: mainBranchSha,
        });
        console.log(`Branch "${newBranchName}" created successfully.`);

        // 4.c Leer Comentarios Existentes
        let existingComments = [];
        let fileSha = null;
        try {
            const { data: fileData } = await octokit.repos.getContent({
                owner: REPO_OWNER,
                repo: REPO_NAME,
                path: commentsFilePath,
                ref: newBranchName, // Leer de la nueva rama (o de la principal si aún no existe el archivo)
            });
            if (fileData.content) {
                existingComments = JSON.parse(Base64.decode(fileData.content));
                fileSha = fileData.sha;
            }
        } catch (error) {
            if (error.status !== 404) throw error; // Si es un error diferente a "no encontrado", relanzar
            console.log(`Comments file "${commentsFilePath}" not found. Creating new one.`);
            // El archivo no existe, se creará uno nuevo. existingComments ya es [] y fileSha es null.
        }

        // 4.d Añadir el Nuevo Comentario
        const updatedComments = [...existingComments, commentData];

        // 4.f Actualizar/Crear el Archivo de Comentarios en la Nueva Rama
        const commitMessage = `feat: Add new comment to ${article_title} (ID: ${commentData.id})`;
        await octokit.repos.createOrUpdateFileContents({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: commentsFilePath,
            message: commitMessage,
            content: Base64.encode(JSON.stringify(updatedComments, null, 2)),
            sha: fileSha, // null si el archivo es nuevo
            branch: newBranchName,
            committer: { name: "Netlify Comments Bot", email: "bot@netlify.com" }, // Opcional
            author: { name: "Netlify Comments Bot", email: "bot@netlify.com" },    // Opcional
        });
        console.log(`Comments file "${commentsFilePath}" updated in branch "${newBranchName}".`);

        // 4.g Crear un Pull Request (PR)
        const prTitle = `New Comment: ${article_title} by ${name}`;
        const prBody = `
New comment submitted for article: **${article_title}** (\`slug: ${article_slug}\`)
By: **${name}**
Comment ID: \`${commentData.id}\`

---
**Comment:**
> ${comment}
---

Please review and merge if appropriate.
Submission ID: ${submissionId}
`;
        const { data: pullRequest } = await octokit.pulls.create({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            title: prTitle,
            head: newBranchName,
            base: REPO_BRANCH,
            body: prBody,
            maintainer_can_modify: true, // Opcional
        });
        console.log(`Pull request created: ${pullRequest.html_url}`);

        // 5. Manejo de la Sumisión en Netlify Forms (Opcional)
        // Si deseas, puedes eliminar la sumisión después de crear el PR exitosamente.
        // const netlifyApiToken = process.env.NETLIFY_API_TOKEN; // Necesitarías un token de API de Netlify
        // if (netlifyApiToken && submissionId) {
        //    await fetch(`https://api.netlify.com/api/v1/submissions/${submissionId}`, {
        //        method: 'DELETE',
        //        headers: { Authorization: `Bearer ${netlifyApiToken}` }
        //    });
        //    console.log(`Submission ${submissionId} deleted from Netlify Forms.`);
        // }

        // 6. Notificación (Opcional) - Implementar envío de email/Slack aquí si se desea.

        // 7. Respuesta de la Función
        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Comment submitted for moderation. Thank you!", pr_url: pullRequest.html_url }),
        };

    } catch (error) {
        console.error("Error processing comment:", error);
        // Intentar limpiar la rama si se creó y hubo un error posterior
        if (error.attemptedBranchCreation && newBranchName) {
            try {
                await octokit.git.deleteRef({
                    owner: REPO_OWNER,
                    repo: REPO_NAME,
                    ref: `heads/${newBranchName}`,
                });
                console.log(`Cleaned up branch "${newBranchName}" due to error.`);
            } catch (cleanupError) {
                console.error(`Failed to cleanup branch "${newBranchName}":`, cleanupError);
            }
        }
        return {
            statusCode: 500,
            body: `Error processing comment: ${error.message}`,
        };
    }
};
