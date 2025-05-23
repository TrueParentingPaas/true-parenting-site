// netlify/functions/submission-created.js

const { Base64 } = require("js-base64");

// Variables de entorno con valores por defecto donde sea apropiado
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GITHUB_REPO_OWNER;
const REPO_NAME = process.env.GITHUB_REPO_NAME;
const REPO_BRANCH = process.env.GITHUB_REPO_BRANCH || "main";
const FORM_NAME_PREFIX = process.env.NETLIFY_FORM_NAME_PREFIX || "comments-";

// Función para logging estructurado
const log = {
  info: (message, data = null) => {
    console.log(`[INFO] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  warn: (message, data = null) => {
    console.warn(`[WARN] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  error: (message, error = null) => {
    console.error(`[ERROR] ${message}`);
    if (error) {
      console.error('Error details:', error.message);
      if (error.stack) console.error('Stack trace:', error.stack);
      if (error.response?.data) console.error('API Response:', error.response.data);
    }
  }
};

// Función para validar configuración inicial
const validateConfiguration = () => {
  log.info('🚀 Function invoked - Starting configuration validation');
  
  const requiredEnvVars = {
    GITHUB_TOKEN: GITHUB_TOKEN,
    GITHUB_REPO_OWNER: REPO_OWNER,
    GITHUB_REPO_NAME: REPO_NAME
  };
  
  const missingVars = Object.entries(requiredEnvVars)
    .filter(([key, value]) => !value)
    .map(([key]) => key);
  
  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }
  
  log.info('✅ Environment variables validated', {
    REPO_OWNER,
    REPO_NAME,
    REPO_BRANCH,
    FORM_NAME_PREFIX,
    GITHUB_TOKEN_LENGTH: GITHUB_TOKEN ? GITHUB_TOKEN.length : 0
  });
  
  return true;
};

// Función para inicializar Octokit con validación
const initializeOctokit = async () => {
  try {
    log.info('📦 Attempting dynamic import of Octokit...');
    const { Octokit } = await import("@octokit/rest");
    log.info('✅ Octokit imported successfully');
    
    const octokit = new Octokit({ auth: GITHUB_TOKEN });
    log.info('✅ Octokit instance created');
    
    // Verificar autenticación haciendo una llamada simple
    log.info('🔐 Testing GitHub authentication...');
    await octokit.users.getAuthenticated();
    log.info('✅ GitHub authentication successful');
    
    return octokit;
  } catch (error) {
    log.error('❌ Failed to initialize Octokit', error);
    throw new Error(`Octokit initialization failed: ${error.message}`);
  }
};

// Función principal del handler
exports.handler = async (event) => {
  const startTime = Date.now();
  
  try {
    // 1. Validar configuración inicial
    validateConfiguration();
    
    // 2. Verificar método HTTP
    if (event.httpMethod !== "POST") {
      log.warn('Invalid HTTP method', { method: event.httpMethod });
      return { statusCode: 405, body: "Method Not Allowed" };
    }
    log.info('✅ HTTP method validated (POST)');
    
    // 3. Inicializar Octokit
    const octokit = await initializeOctokit();
    
    // 4. Parsear el payload
    let payload;
    try {
      log.info('📋 Parsing request payload...');
      payload = JSON.parse(event.body).payload;
      log.info('✅ Payload parsed successfully', { 
        form_name: payload?.form_name,
        submission_id: payload?.id,
        data_keys: payload?.data ? Object.keys(payload.data) : []
      });
    } catch (error) {
      log.error('❌ Error parsing request payload', error);
      return { statusCode: 400, body: "Malformed request body." };
    }
    
    // 5. Validar estructura del payload
    const { data, form_name, id: submissionId } = payload;
    
    if (!form_name || !form_name.startsWith(FORM_NAME_PREFIX)) {
      log.info('Form name does not match prefix - skipping', {
        form_name,
        expected_prefix: FORM_NAME_PREFIX
      });
      return {
        statusCode: 200,
        body: JSON.stringify({ message: `Form "${form_name}" not a comment form. Submission skipped.` }),
      };
    }
    log.info('✅ Form name validated');
    
    // 6. Extraer y validar datos del formulario
    const { name, comment, article_slug, article_title, email, "bot-field": botField } = data;
    
    // Verificar honeypot
    if (botField) {
      log.warn('Bot submission detected (honeypot filled)', { botField });
      return { statusCode: 400, body: JSON.stringify({ error: "Spam submission detected." }) };
    }
    log.info('✅ Honeypot check passed');
    
    // Verificar campos requeridos
    if (!name || !comment || !article_slug || !article_title) {
      const missing = [
        !name && "name",
        !comment && "comment",
        !article_slug && "article_slug",
        !article_title && "article_title",
      ].filter(Boolean).join(", ");
      
      log.error('Missing required fields', { missing, provided_data: data });
      return { statusCode: 400, body: JSON.stringify({ error: `Missing required fields: ${missing}` }) };
    }
    log.info('✅ Required fields validated');
    
    // Verificar longitud del comentario
    if (comment.length > 2000) {
      log.warn('Comment too long', { length: comment.length, max: 2000 });
      return { statusCode: 400, body: JSON.stringify({ error: "Comment is too long (max 2000 chars)." }) };
    }
    log.info('✅ Comment length validated', { length: comment.length });
    
    // 7. Preparar datos del comentario
    const commentData = {
      id: Date.now().toString(),
      name: name.trim(),
      comment: comment.trim(),
      date: new Date().toISOString(),
    };
    log.info('✅ Comment data prepared', { comment_id: commentData.id });
    
    // 8. Preparar configuración para GitHub
    const commentsFilePath = `_data/comments/${article_slug}.json`;
    const sanitizedSlug = String(article_slug).replace(/[^a-z0-9]/gi, "-");
    const newBranchName = `comment-${sanitizedSlug}-${commentData.id}`;
    let branchCreated = false;
    
    log.info('🔄 Starting GitHub operations', {
      file_path: commentsFilePath,
      branch_name: newBranchName,
      article_slug,
      sanitized_slug: sanitizedSlug
    });
    
    // 9. Obtener referencia de la rama principal
    log.info('📥 Getting main branch reference...');
    const { data: mainBranch } = await octokit.git.getRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `heads/${REPO_BRANCH}`,
    });
    const mainBranchSha = mainBranch.object.sha;
    log.info('✅ Main branch reference obtained', { sha: mainBranchSha.substring(0, 8) });
    
    // 10. Crear nueva rama
    log.info('🌿 Creating new branch...');
    await octokit.git.createRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `refs/heads/${newBranchName}`,
      sha: mainBranchSha,
    });
    branchCreated = true;
    log.info('✅ Branch created successfully', { branch: newBranchName });
    
    // 11. Obtener comentarios existentes
    let existingComments = [];
    let fileSha = null;
    
    try {
      log.info('📄 Checking for existing comments file...');
      const { data: fileData } = await octokit.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: commentsFilePath,
        ref: newBranchName,
      });
      
      if (fileData.content) {
        existingComments = JSON.parse(Base64.decode(fileData.content));
        fileSha = fileData.sha;
        log.info('✅ Existing comments loaded', { count: existingComments.length });
      }
    } catch (error) {
      if (error.status === 404) {
        log.info('📄 Comments file not found - will create new one');
      } else {
        throw error;
      }
    }
    
    // 12. Actualizar comentarios
    const updatedComments = [...existingComments, commentData];
    const commitMessage = `feat: Add new comment to ${article_title} (ID: ${commentData.id})`;
    
    log.info('💾 Updating comments file...');
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
    log.info('✅ Comments file updated', { total_comments: updatedComments.length });
    
    // 13. Crear Pull Request
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
    
    log.info('📝 Creating pull request...');
    const { data: pullRequest } = await octokit.pulls.create({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      title: prTitle,
      head: newBranchName,
      base: REPO_BRANCH,
      body: prBody,
    });
    
    const executionTime = Date.now() - startTime;
    log.info('🎉 Pull request created successfully', {
      pr_url: pullRequest.html_url,
      pr_number: pullRequest.number,
      execution_time_ms: executionTime
    });
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Comment submitted for moderation. Thank you!",
        pr_url: pullRequest.html_url,
      }),
    };
    
  } catch (error) {
    const executionTime = Date.now() - startTime;
    log.error('💥 Function execution failed', error);
    log.info('Execution context', {
      execution_time_ms: executionTime,
      branch_created: !!branchCreated,
      branch_name: newBranchName || 'N/A'
    });
    
    // Limpieza de rama si se creó
    if (branchCreated && newBranchName) {
      try {
        log.info('🧹 Attempting branch cleanup...');
        const { Octokit } = await import("@octokit/rest");
        const cleanupOctokit = new Octokit({ auth: GITHUB_TOKEN });
        
        await cleanupOctokit.git.deleteRef({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          ref: `heads/${newBranchName}`,
        });
        log.info('✅ Branch cleanup successful');
      } catch (cleanupError) {
        log.error('❌ Branch cleanup failed', cleanupError);
      }
    }
    
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Error processing comment: ${error.message}` }),
    };
  }
};
