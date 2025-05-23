// netlify/functions/submission-created.js

const { Octokit } = require("@octokit/rest");
const { Base64 } = require("js-base64");

// Variables de entorno para GitHub y para la API de Netlify
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GITHUB_REPO_OWNER;
const REPO_NAME = process.env.GITHUB_REPO_NAME;
const REPO_BRANCH = process.env.GITHUB_REPO_BRANCH || "main";
const FORM_NAME_PREFIX = process.env.NETLIFY_FORM_NAME_PREFIX || "comments-";

// Variables para Netlify deploy
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID;
const NETLIFY_ACCESS_TOKEN = process.env.NETLIFY_ACCESS_TOKEN;

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
    return { 
      statusCode: 400, 
      body: JSON.stringify({ error: "Spam submission detected." }) 
    };
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
    return { 
      statusCode: 400, 
      body: JSON.stringify({ error: `Missing required fields: ${missing}` }) 
    };
  }
  if (comment.length > 2000) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Comment is too long (max 2000 chars)." })
    };
  }

  // Nuevo comentario
  const commentData = {
    id: Date.now().toString(),
    name: name.trim(),
    comment: comment.trim(),
    date: new Date().toISOString(),
  };

  const commentsFilePath = `_data/comments/${article_slug}.json`;
  // Saneamos el nombre del archivo (slug)
  const sanitizedSlug = String(article_slug).replace(/[^a-z0-9]/gi, "-");
  // Creamos el nombre de la rama a partir del slug y el timestamp
  const newBranchName = `comment-${sanitizedSlug}-${commentData.id}`;
  
  let branchCreated = false;
  
  try {
    // Obtenemos el SHA de la rama main para usar como base
    const { data: mainBranch } = await octokit.git.getRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `heads/${REPO_BRANCH}`,
    });
    const mainBranchSha = mainBranch.object.sha;
    
    // Creamos la nueva rama fuera de main
    await octokit.git.createRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `refs/heads/${newBranchName}`,
      sha: mainBranchSha,
    });
    branchCreated = true;
    console.log(`Branch "${newBranchName}" created successfully.`);
    
    // Obtener el contenido actual del archivo de comentarios en la rama main
    let existingComments = [];
    let fileSha = null;
    try {
      const { data: fileData } = await octokit.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: commentsFilePath,
        ref: newBranchName, // Leemos en la rama que acabamos de crear
      });
      if (fileData.content) {
        existingComments = JSON.parse(Base64.decode(fileData.content));
        fileSha = fileData.sha;
      }
    } catch (error) {
      if (error.status !== 404) throw error;
      console.log(`Comments file "${commentsFilePath}" not found in branch "${newBranchName}". It will be created.`);
    }
    
    // Añadimos el nuevo comentario al JSON
    const updatedComments = [...existingComments, commentData];
    const commitMessage = `feat: Add new comment to ${article_title} (ID: ${commentData.id})`;
    
    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: commentsFilePath,
      message: commitMessage,
      content: Base64.encode(JSON.stringify(updatedComments, null, 2)),
      sha: fileSha, // Si fileSha es null, se creará el archivo
      branch: newBranchName,
      committer: { name: "Netlify Comments Bot", email: "netlify-bot@example.com" },
      author: { name: "Netlify Comments Bot", email: "netlify-bot@example.com" },
    });
    console.log(`Comments file "${commentsFilePath}" updated in branch "${newBranchName}".`);
    
    // Creamos el Pull Request desde la nueva rama a main (para registro o auditoría)
    const prTitle = `New Comment: ${article_title} by ${name}`;
    const prBody = `
New comment submitted for article: **${article_title}** (\`slug: ${article_slug}\`)
By: **${name}**
User Email: ${email || "Not provided"}
Comment ID: \`${commentData.id}\`

---
**Comment:**
> ${comment}
    
This pull request deploys from branch \`${newBranchName}\`.
    `;
    const { data: pullRequest } = await octokit.pulls.create({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      title: prTitle,
      head: newBranchName,
      base: REPO_BRANCH,
      body: prBody,
    });
    console.log(`Pull request created: ${pullRequest.html_url}`);
    
    // --- Trigger Netlify deploy desde la nueva rama ---
    // Esto utiliza la API de Netlify para lanzar un deploy desde la rama recién creada.
    if (NETLIFY_SITE_ID && NETLIFY_ACCESS_TOKEN) {
      console.log(`Triggering deploy for branch: ${newBranchName}`);
      const deployResponse = await fetch(
        `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/builds`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${NETLIFY_ACCESS_TOKEN}`
          },
          // Envia la rama que deseas desplegar.
          body: JSON.stringify({ branch: newBranchName })
        }
      );
      
      if (!deployResponse.ok) {
        const errorText = await deployResponse.text();
        console.error("Deploy trigger failed:", errorText);
      } else {
        const deployData = await deployResponse.json();
        console.log("Deploy triggered for branch:", newBranchName, deployData);
      }
    } else {
      console.warn("NETLIFY_SITE_ID or NETLIFY_ACCESS_TOKEN not set. Skipping deploy trigger.");
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Comment submitted, branch created, PR generated and deploy triggered.",
        pr_url: pullRequest.html_url,
        deploy_branch: newBranchName
      }),
    };
    
  } catch (error) {
    console.error("Error processing comment submission:", error.message
