// netlify/functions/submission-created.js

// Usar require para CommonJS, que es a menudo el entorno por defecto en Netlify Functions para .js
const { Octokit } = require("@octokit/rest");
const { Base64 } = require("js-base64"); // Asegúrate de que esté instalado: npm install js-base64

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GITHUB_REPO_OWNER;
const REPO_NAME = process.env.GITHUB_REPO_NAME;
const REPO_BRANCH = process.env.GITHUB_REPO_BRANCH || "main";
const FORM_NAME_PREFIX = process.env.NETLIFY_FORM_NAME_PREFIX || "comments-";

// Inicializar Octokit globalmente.
let octokit;
try {
  octokit = new Octokit({ auth: GITHUB_TOKEN });
} catch (initError) {
  console.error("Failed to initialize Octokit:", initError);
  // Si Octokit no se puede inicializar, la función fallará al ejecutarse.
}

exports.handler = async (event) => {
  // Verificar si Octokit se inicializó correctamente
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
    // Según la estructura del event, el payload relevante suele estar en event.body.payload
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
      !article_title && "article_title",
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
  // Convertimos article_slug a cadena antes de aplicar replace para asegurarnos de que sea válido
  const sanitizedSlug = String(article_slug).replace(/[^a-z0-9]/gi, "-");
  const newBranchName = `comment-${sanitizedSlug}-${commentData.id}`;

  let branchCreated = false;

  try {
    const { data: mainBranch } = await octokit.git.getRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `heads/${REPO_BRANCH}`,
    });
    const mainBranchSha = mainBranch.object.sha;

    await octokit.git.createRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `refs/heads/${newBranchName}`,
      sha: mainBranchSha,
    });
    branchCreated = true;
    console.log(`Branch "${newBranchName}" created successfully.`);

    let existingComments = [];
    let fileSha = null;
    try {
      const { data: fileData } = await octokit.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: commentsFilePath,
        ref: newBranchName,
      });
      if (fileData.content) {
        existingComments = JSON.parse(Base64.decode(fileData.content));
        fileSha = fileData.sha;
      }
    } catch (error) {
      if (error.status !== 404) throw error;
      console.log(`Comments file "${commentsFilePath}" not found. Creating new one.`);
    }

    const updatedComments = [...existingComments, commentData];
    const commitMessage = `feat: Add new comment to ${article_title} (ID: ${commentData.id})`;

    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: commentsFilePath,
      message: commitMessage,
      content: Base64.encode(JSON.stringify(updatedComments, null, 2)),
      sha: fileSha,
      branch: newBranchName,
      committer: { name: "Netlify Comments Bot", email: "netlify-bot@example.com" },
      author: { name: "Netlify Comments Bot", email: "netlify-bot@example.com" },
    });
    console.log(`Comments file "${commentsFilePath}" updated in branch "${newBranchName}".`);

    const prTitle = `New Comment: ${article_title} by ${name}`;
    const prBody = `
New comment submitted for article: **${article_title}** (\`slug: ${article_slug}\`)
By: **${name}**
User Email (for admin reference, not public): ${email || "Not provided"}
Comment ID: \`${commentData.id}\`

---
**Comment:**
> ${comment}
---

Please review and merge if appropriate.
Netlify Submission ID: ${submissionId || "N/A"}
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

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Comment submitted for moderation. Thank you!",
        pr_url: pullRequest.html_url,
      }),
    };

  } catch (error) {
    console.error("Error processing comment submission:", error.message);
    if (error.stack) console.error(error.stack);
    if (error.response && error.response.data) {
      console.error("GitHub API Error:", error.response.data);
    }

    if (branchCreated) {
      try {
        console.log(`Attempting to clean up branch "${newBranchName}" due to error.`);
        await octokit.git.deleteRef({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          ref: `heads/${newBranchName}`,
        });
        console.log(`Cleaned up branch "${newBranchName}" successfully.`);
      } catch (cleanupError) {
        console.error(`Failed to cleanup branch "${newBranchName}":`, cleanupError.message);
      }
    }
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Error processing comment: ${error.message}` }),
    };
  }
};
