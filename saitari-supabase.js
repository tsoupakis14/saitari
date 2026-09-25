/* Saitari cloud bridge: authenticated Supabase storage + safe localStorage migration. */
(function () {
  "use strict";

  const SUPABASE_URL = "https://pavdomvbzpinrnkqiphq.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_6EXvufRNR6eXODzr192JIg_sKq5XIFa";
  const BUCKET = "saitari-uploads";
  const KEYS = {
    projects: "saitari-projects",
    deletedProjects: "saitari-deleted-projects",
    requests: "saitari-requests",
    archived: "saitari-archived-requests",
    history: "saitari-archive-history"
  };
  const STATUS_CLASS = {
    "Νέο": "status-new",
    "Σε εξέλιξη": "status-progress",
    "Για έγκριση": "status-review",
    "Ολοκληρώθηκε": "status-done"
  };

  let client;
  let activeUser;
  let activeProfile;
  let appProfiles = [];
  let knownRequestIds = new Set();
  let knownCommentIds = new Set();
  let syncing = false;
  let syncTimer;
  let lastSnapshot = "";
  let refreshTimer;

  function addStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .saitari-auth-shade{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:20px;background:rgba(11,16,32,.58);backdrop-filter:blur(5px)}
      .saitari-auth-card{width:min(100%,430px);padding:30px;border:1px solid #e3e8f2;border-radius:16px;background:#fff;box-shadow:0 24px 80px #0b102044;font:400 15px Inter,Arial,sans-serif;color:#151c32}
      .saitari-auth-card h1{margin:0 0 8px;font:700 27px 'Space Grotesk',Inter,Arial,sans-serif;letter-spacing:-.04em;color:#151c32}
      .saitari-auth-card p{margin:0 0 22px;color:#75809a;line-height:1.55}
      .saitari-auth-card label{display:block;margin:15px 0 7px;font-weight:600;font-size:13px}
      .saitari-auth-card input{width:100%;height:46px;padding:0 13px;border:1px solid #dce3ef;border-radius:9px;background:#fff;color:#151c32;font:inherit}
      .saitari-auth-card button{width:100%;height:46px;margin-top:20px;border:0;border-radius:9px;background:#635bff;color:white;font:600 14px Inter,Arial,sans-serif;cursor:pointer}
      .saitari-auth-card button:disabled{opacity:.65;cursor:wait}
      .saitari-auth-error{margin-top:13px!important;color:#b42318!important;font-size:13px}
      .saitari-cloud-exit{border:0;background:transparent;color:#75809a;font:500 12px Inter,Arial,sans-serif;cursor:pointer;padding:7px 4px}
      .saitari-cloud-exit:hover{color:#635bff}
      .saitari-cloud-warning{position:fixed;z-index:5000;right:16px;bottom:16px;max-width:min(430px,calc(100vw - 32px));padding:12px 16px;border:1px solid #f0d6a0;border-radius:10px;background:#fff8e8;color:#664b12;font:13px/1.45 Inter,Arial,sans-serif;box-shadow:0 8px 30px #0b102018}
      .saitari-cloud-progress{position:fixed;z-index:4900;right:16px;bottom:16px;max-width:min(430px,calc(100vw - 32px));padding:12px 16px;border:1px solid #dce3ef;border-radius:10px;background:#fff;color:#3c4966;font:13px/1.45 Inter,Arial,sans-serif;box-shadow:0 8px 30px #0b102018}
      @media(max-width:600px){.saitari-auth-card{padding:24px}.saitari-auth-card h1{font-size:24px}}
    `;
    document.head.appendChild(style);
  }

  function showAuth(errorText) {
    let shade = document.querySelector(".saitari-auth-shade");
    if (!shade) {
      shade = document.createElement("div");
      shade.className = "saitari-auth-shade";
      shade.innerHTML = `<form class="saitari-auth-card" autocomplete="on"><h1>Σύνδεση στο Saitari</h1><p>Συνδέσου για να δεις και να αποθηκεύσεις τα αιτήματα και τους πελάτες σου.</p><label for="saitariLoginEmail">Email</label><input id="saitariLoginEmail" type="email" autocomplete="username" required><label for="saitariLoginPassword">Κωδικός</label><input id="saitariLoginPassword" type="password" autocomplete="current-password" required><button type="submit">Σύνδεση</button><p class="saitari-auth-error" hidden></p></form>`;
      document.body.appendChild(shade);
      shade.querySelector("form").addEventListener("submit", async function (event) {
        event.preventDefault();
        const button = shade.querySelector("button");
        const error = shade.querySelector(".saitari-auth-error");
        button.disabled = true;
        button.textContent = "Σύνδεση…";
        error.hidden = true;
        const result = await client.auth.signInWithPassword({
          email: shade.querySelector("#saitariLoginEmail").value.trim(),
          password: shade.querySelector("#saitariLoginPassword").value
        });
        if (result.error) {
          error.textContent = "Δεν έγινε σύνδεση. Έλεγξε το email και τον κωδικό σου.";
          error.hidden = false;
          button.disabled = false;
          button.textContent = "Σύνδεση";
          return;
        }
        activeUser = result.data.user;
        shade.remove();
      });
    }
    const error = shade.querySelector(".saitari-auth-error");
    if (errorText) {
      error.textContent = errorText;
      error.hidden = false;
    }
    shade.hidden = false;
  }

  function warn(message) {
    let banner = document.querySelector(".saitari-cloud-warning");
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "saitari-cloud-warning";
      document.body.appendChild(banner);
    }
    banner.textContent = message;
  }

  function progress(message) {
    let banner = document.querySelector(".saitari-cloud-progress");
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "saitari-cloud-progress";
      document.body.appendChild(banner);
    }
    banner.textContent = message;
  }

  function addSignOut() {
    const label = activeProfile?.display_name || activeProfile?.email || "Χρήστης";
    const account = document.querySelector(".account");
    if (account) {
      const textNode = [...account.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
      if (textNode) textNode.textContent = label + " ";
      else account.insertBefore(document.createTextNode(label + " "), account.firstChild);
    }
    document.querySelectorAll(".profile strong").forEach(node => { node.textContent = label; });
    document.querySelectorAll(".profile small").forEach(node => { node.textContent = activeProfile?.role === "admin" ? "Admin" : "Πελάτης"; });
    document.querySelectorAll(".avatar").forEach(node => {
      node.textContent = label.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(part => part[0].toLocaleUpperCase("el")).join("") || "S";
    });
    const target = document.querySelector(".top-actions") || account;
    if (!target || target.querySelector(".saitari-cloud-exit")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "saitari-cloud-exit";
    button.textContent = "Έξοδος";
    button.title = activeUser && activeUser.email ? "Αποσύνδεση από " + activeUser.email : "Αποσύνδεση";
    button.addEventListener("click", async function () {
      await client.auth.signOut();
      window.location.reload();
    });
    target.appendChild(button);
  }

  function localSnapshot() {
    return [KEYS.projects, KEYS.deletedProjects, KEYS.requests, KEYS.archived, KEYS.history]
      .map(key => key + "=" + (localStorage.getItem(key) || ""))
      .join("\n");
  }

  function parseRows(markup) {
    const body = document.createElement("tbody");
    body.innerHTML = markup || "";
    return [...body.rows];
  }

  function allLocalRows() {
    return [...parseRows(localStorage.getItem(KEYS.requests)), ...parseRows(localStorage.getItem(KEYS.archived)), ...parseRows(localStorage.getItem(KEYS.history))];
  }

  function backupLocal() {
    const backup = {};
    Object.values(KEYS).forEach(key => { backup[key] = localStorage.getItem(key); });
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { resolve(false); return; }
      const open = indexedDB.open("saitari-local-backup", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("snapshots", { keyPath: "id" });
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("snapshots", "readwrite");
        const store = tx.objectStore("snapshots");
        const existing = store.get(activeUser.id);
        existing.onsuccess = () => {
          if (!existing.result) store.put({ id: activeUser.id, createdAt: new Date().toISOString(), data: backup });
        };
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => { const error = tx.error; db.close(); reject(error); };
      };
    });
  }

  function uuid() { return crypto.randomUUID(); }

  function dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
    const comma = dataUrl.indexOf(",");
    const mime = dataUrl.slice(5, dataUrl.indexOf(";", 5)) || "image/jpeg";
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { blob: new Blob([bytes], { type: mime }), mime };
  }

  function extension(mime) {
    return mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  }

  async function signed(path) {
    if (!path) return "";
    const { data, error } = await client.storage.from(BUCKET).createSignedUrl(path, 86400);
    if (error) throw error;
    return data.signedUrl;
  }

  async function fetchCloud() {
    const results = await Promise.all([
      client.from("profiles").select("user_id,email,display_name,role"),
      client.from("projects").select("*").order("created_at", { ascending: true }),
      client.from("requests").select("*").is("deleted_at", null).order("created_at", { ascending: false }),
      client.from("comments").select("*").order("created_at", { ascending: true }),
      client.from("attachments").select("*")
    ]);
    const failure = results.find(result => result.error);
    if (failure) throw failure.error;
    return { profiles: results[0].data || [], projects: results[1].data || [], requests: results[2].data || [], comments: results[3].data || [], attachments: results[4].data || [] };
  }

  function normalizeRow(row) {
    if (row.cells[0]?.classList.contains("request-number")) row.deleteCell(0);
    if (row.querySelector(".ellipsis")) row.deleteCell(row.cells.length - 1);
    const statusIndex = [...row.cells].findIndex(cell => cell.querySelector(".status"));
    if (statusIndex === 2) {
      const website = row.dataset.website || row.querySelector(".request-website-label")?.textContent.trim() || "—";
      if (row.cells[1]?.textContent.trim() !== website) row.insertCell(1).textContent = website;
      else {
        const areaCell = row.insertCell(2);
        areaCell.textContent = row.dataset.area || "—";
      }
    }
    row.querySelector(".request-website-label")?.remove();
    return row;
  }

  async function importLocalSnapshot() {
    await backupLocal();
    let projects = [];
    try { projects = JSON.parse(localStorage.getItem(KEYS.projects) || "[]"); } catch (_) {}
    const deleted = new Set();
    try { JSON.parse(localStorage.getItem(KEYS.deletedProjects) || "[]").forEach(name => deleted.add(name)); } catch (_) {}
    const projectMap = new Map();
    const projectPayload = [];
    const pendingImages = [];
    const keepPaths = new Set();

    const isAdmin = activeProfile?.role === "admin";
    for (const p of (isAdmin ? projects.filter(item => item && item.name && !deleted.has(item.name)) : projects.filter(item => item && item.name))) {
      p.cloudId = p.cloudId || uuid();
      projectMap.set(p.name, p.cloudId);
      let logoPath = p.logoPath || null;
      if (p.logo && p.logo.startsWith("data:")) {
        logoPath = `${activeUser.id}/projects/${p.cloudId}/logo.${extension(dataUrlToBlob(p.logo).mime)}`;
        p.logoPath = logoPath;
        pendingImages.push({ dataUrl: p.logo, path: logoPath, fileName: `${p.name}-logo`, parent: { project_id: p.cloudId }, replace: url => { p.logo = url; } });
      }
      if (logoPath) keepPaths.add(logoPath);
      if (!isAdmin) continue;
      projectPayload.push({
        id: p.cloudId,
        owner_id: activeUser.id,
        name: p.name,
        client_name: p.client || p.contact || "",
        project_type: p.type || "Website",
        description: p.description || "",
        website_url: p.url || null,
        client_user_id: p.clientUserId || null,
        status: p.status === "Ανενεργός" ? "Ανενεργός" : "Ενεργός",
        logo_path: logoPath,
        updated_at: p.updatedAt ? new Date(p.updatedAt).toISOString() : new Date().toISOString()
      });
    }
    if (isAdmin && projectPayload.length) {
      const { error } = await client.from("projects").upsert(projectPayload, { onConflict: "id" });
      if (error) throw error;
    }
    await uploadPending(pendingImages);
    pendingImages.length = 0;
    if (isAdmin) localStorage.setItem(KEYS.projects, JSON.stringify(projects));

    const rowGroups = [KEYS.requests, KEYS.archived, KEYS.history].map(key => ({ key, rows: parseRows(localStorage.getItem(key)).map(normalizeRow) }));
    const sourceRows = rowGroups.flatMap(group => group.rows);
    const requestPayload = [];
    const commentPayload = [];
    const requestIds = new Set();
    const commentIds = new Set();

    for (const row of sourceRows) {
      const id = row.dataset.cloudId || uuid();
      row.dataset.cloudId = id;
      requestIds.add(id);
      let comments = [];
      let images = [];
      let imagePaths = [];
      try { comments = JSON.parse(row.dataset.comments || "[]"); } catch (_) {}
      try { images = JSON.parse(row.dataset.images || "[]"); } catch (_) {}
      try { imagePaths = JSON.parse(row.dataset.imagePaths || "[]"); } catch (_) {}
      while (imagePaths.length < images.length) imagePaths.push(null);
      const title = row.dataset.title || row.querySelector(".request-title")?.textContent.trim() || "Αίτημα";
      const status = row.querySelector(".status")?.textContent.trim() || row.dataset.status || "Νέο";
      const projectName = row.dataset.website || row.cells[1]?.textContent.trim() || "";
      const projectId = projectMap.get(projectName) || null;
      const createdAt = row.dataset.createdAt || new Date().toISOString();
      row.dataset.createdAt = createdAt;
      const requestRecord = {
        id,
        owner_id: activeUser.id,
        project_id: projectId,
        project_name: projectName,
        title,
        area: row.dataset.area || row.cells[2]?.textContent.trim() || "",
        priority: ["Κανονική", "Υψηλή", "Χαμηλή"].includes(row.dataset.priority) ? row.dataset.priority : "Κανονική",
        description: row.dataset.description || "",
        status: ["Νέο", "Σε εξέλιξη", "Για έγκριση", "Ολοκληρώθηκε"].includes(status) ? status : "Νέο",
        created_at: createdAt,
        completed_at: status === "Ολοκληρώθηκε" ? (row.dataset.completedAt || createdAt) : null,
        archived_at: row.dataset.archivedAt || null,
        deleted_at: null
      };
      if (isAdmin || !knownRequestIds.has(id)) requestPayload.push(requestRecord);

      for (let index = 0; index < images.length; index++) {
        if (!String(images[index]).startsWith("data:")) {
          if (imagePaths[index]) keepPaths.add(imagePaths[index]);
          continue;
        }
        const type = dataUrlToBlob(images[index]).mime;
        const path = imagePaths[index] || `${activeUser.id}/requests/${id}/image-${index + 1}.${extension(type)}`;
        imagePaths[index] = path;
        keepPaths.add(path);
        pendingImages.push({ dataUrl: images[index], path, fileName: `${title}-image-${index + 1}`, parent: { request_id: id }, replace: url => { images[index] = url; row.dataset.images = JSON.stringify(images); } });
      }
      row.dataset.imagePaths = JSON.stringify(imagePaths);

      for (const comment of comments) {
        comment.id = comment.id || uuid();
        commentIds.add(comment.id);
        const commentCreated = comment.createdAt || new Date().toISOString();
        comment.createdAt = commentCreated;
        let imagePath = comment.imagePath || null;
        if (comment.image && String(comment.image).startsWith("data:")) {
          const type = dataUrlToBlob(comment.image).mime;
          imagePath = imagePath || `${activeUser.id}/comments/${comment.id}/image.${extension(type)}`;
          comment.imagePath = imagePath;
          keepPaths.add(imagePath);
          pendingImages.push({ dataUrl: comment.image, path: imagePath, fileName: "comment-image", parent: { comment_id: comment.id }, replace: url => { comment.image = url; row.dataset.comments = JSON.stringify(comments); } });
        } else if (imagePath) keepPaths.add(imagePath);
        const commentRecord = {
          id: comment.id,
          owner_id: activeUser.id,
          request_id: id,
          author_name: comment.author || "Tasos",
          sender_role: comment.role === "client" ? "client" : "designer",
          body: comment.text || "",
          created_at: commentCreated
        };
        if (isAdmin || !knownCommentIds.has(comment.id)) commentPayload.push(commentRecord);
      }
      row.dataset.comments = JSON.stringify(comments);
    }

    if (requestPayload.length) {
      const requestWrite = isAdmin
        ? client.from("requests").upsert(requestPayload, { onConflict: "id" })
        : client.from("requests").insert(requestPayload);
      const { error } = await requestWrite;
      if (error) throw error;
      requestPayload.forEach(item => knownRequestIds.add(item.id));
    }
    if (commentPayload.length) {
      const commentWrite = isAdmin
        ? client.from("comments").upsert(commentPayload, { onConflict: "id" })
        : client.from("comments").insert(commentPayload);
      const { error } = await commentWrite;
      if (error) throw error;
      commentPayload.forEach(item => knownCommentIds.add(item.id));
    }
    await uploadPending(pendingImages);

    rowGroups.forEach(group => localStorage.setItem(group.key, group.rows.map(row => row.outerHTML).join("")));
    localStorage.setItem(KEYS.projects, JSON.stringify(projects));
    const processedRows = new Map(sourceRows.filter(row => row.dataset.cloudId).map(row => [row.dataset.cloudId, row]));
    document.querySelectorAll("tr[data-cloud-id]").forEach(liveRow => {
      const savedRow = processedRows.get(liveRow.dataset.cloudId);
      if (!savedRow) return;
      ["images", "imagePaths", "comments", "createdAt", "completedAt", "archivedAt"].forEach(name => {
        if (savedRow.dataset[name] !== undefined) liveRow.dataset[name] = savedRow.dataset[name];
        else delete liveRow.dataset[name];
      });
    });

    // Remove cloud rows deleted in the UI, once the browser has loaded the full cloud snapshot.
    if (!isAdmin) return;
    const [remoteRequests, remoteProjects, remoteComments, remoteAttachments] = await Promise.all([
      client.from("requests").select("id"), client.from("projects").select("id"), client.from("comments").select("id"), client.from("attachments").select("id,storage_path")
    ]);
    for (const result of [remoteRequests, remoteProjects, remoteComments, remoteAttachments]) if (result.error) throw result.error;
    const staleRequests = remoteRequests.data.filter(r => !requestIds.has(r.id)).map(r => r.id);
    const staleProjects = remoteProjects.data.filter(p => !projectPayload.some(local => local.id === p.id)).map(p => p.id);
    const activeCommentIds = new Set(commentPayload.map(c => c.id));
    const staleComments = remoteComments.data.filter(c => !activeCommentIds.has(c.id) && requestIds.size).map(c => c.id);
    const stalePaths = remoteAttachments.data.filter(a => !keepPaths.has(a.storage_path));
    if (staleRequests.length) {
      const { error } = await client.from("requests").delete().in("id", staleRequests);
      if (error) throw error;
    }
    if (staleProjects.length) {
      const { error } = await client.from("projects").delete().in("id", staleProjects);
      if (error) throw error;
    }
    if (staleComments.length) {
      const { error } = await client.from("comments").delete().in("id", staleComments);
      if (error) throw error;
    }
    if (stalePaths.length) {
      const paths = stalePaths.map(item => item.storage_path);
      await client.storage.from(BUCKET).remove(paths);
      const { error } = await client.from("attachments").delete().in("id", stalePaths.map(item => item.id));
      if (error) throw error;
    }
  }

  async function uploadPending(queue) {
    for (const item of queue) {
      const parsed = dataUrlToBlob(item.dataUrl);
      if (!parsed) continue;
      const { error: uploadError } = await client.storage.from(BUCKET).upload(item.path, parsed.blob, {
        contentType: parsed.mime,
        upsert: true,
        cacheControl: "3600"
      });
      if (uploadError) throw uploadError;
      const { error } = await client.from("attachments").upsert({
        owner_id: activeUser.id,
        storage_path: item.path,
        file_name: item.fileName,
        content_type: parsed.mime,
        size_bytes: parsed.blob.size,
        request_id: item.parent.request_id || null,
        comment_id: item.parent.comment_id || null,
        project_id: item.parent.project_id || null
      }, { onConflict: "storage_path" });
      if (error) throw error;
      if (item.replace) item.replace(await signed(item.path));
    }
  }

  async function hydrateLocal() {
    const cloud = await fetchCloud();
    await backupLocal();
    const attachmentByRequest = new Map();
    const attachmentByComment = new Map();
    const attachmentByProject = new Map();
    for (const attachment of cloud.attachments) {
      const url = await signed(attachment.storage_path);
      const value = { ...attachment, url };
      if (attachment.request_id) attachmentByRequest.set(attachment.request_id, [...(attachmentByRequest.get(attachment.request_id) || []), value]);
      if (attachment.comment_id) attachmentByComment.set(attachment.comment_id, value);
      if (attachment.project_id) attachmentByProject.set(attachment.project_id, value);
    }

    appProfiles = cloud.profiles;
    knownRequestIds = new Set(cloud.requests.map(item => item.id));
    knownCommentIds = new Set(cloud.comments.map(item => item.id));
    const profileById = new Map(cloud.profiles.map(profile => [profile.user_id, profile]));
    const projects = cloud.projects.map(project => {
      const logo = attachmentByProject.get(project.id);
      return {
        id: project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || project.id,
        cloudId: project.id,
        clientUserId: project.client_user_id || "",
        assignedClientEmail: profileById.get(project.client_user_id)?.email || "",
        name: project.name,
        client: project.client_name || "",
        description: project.description || "",
        status: project.status,
        type: project.project_type || "Website",
        url: project.website_url || "",
        logo: logo?.url || "",
        logoPath: project.logo_path || logo?.storage_path || "",
        updatedAt: Date.parse(project.updated_at || project.created_at) || Date.now()
      };
    });
    localStorage.setItem(KEYS.projects, JSON.stringify(projects));
    localStorage.setItem(KEYS.deletedProjects, "[]");
    localStorage.setItem("saitari-cloud-has-projects", cloud.projects.length ? "true" : "false");

    const commentsByRequest = new Map();
    for (const comment of cloud.comments) {
      const attach = attachmentByComment.get(comment.id);
      commentsByRequest.set(comment.request_id, [...(commentsByRequest.get(comment.request_id) || []), {
        id: comment.id,
        author: comment.author_name || "Tasos",
        role: comment.sender_role === "client" ? "client" : "designer",
        text: comment.body,
        image: attach?.url || "",
        imagePath: attach?.storage_path || "",
        createdAt: comment.created_at,
        date: new Date(comment.created_at).toLocaleString("el-GR")
      }]);
    }

    const activeRows = [];
    const archivedRows = [];
    for (const request of cloud.requests) {
      const row = document.createElement("tr");
      const cells = [request.title, request.project_name || "—", request.area || "—"];
      cells.forEach((value, index) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        if (index === 0) cell.className = "request-title";
        row.appendChild(cell);
      });
      const statusCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "status " + (STATUS_CLASS[request.status] || "status-new");
      badge.textContent = request.status;
      statusCell.appendChild(badge);
      row.appendChild(statusCell);
      const submitted = document.createElement("td");
      submitted.textContent = new Date(request.created_at).toLocaleString("el-GR");
      row.appendChild(submitted);
      row.dataset.cloudId = request.id;
      row.dataset.title = request.title;
      row.dataset.website = request.project_name || "";
      row.dataset.area = request.area || "";
      row.dataset.priority = request.priority;
      row.dataset.description = request.description || "";
      row.dataset.status = request.status;
      row.dataset.createdAt = request.created_at;
      if (request.completed_at) row.dataset.completedAt = request.completed_at;
      if (request.archived_at) row.dataset.archivedAt = request.archived_at;
      const photos = (attachmentByRequest.get(request.id) || []).sort((a,b) => a.created_at.localeCompare(b.created_at));
      row.dataset.images = JSON.stringify(photos.map(item => item.url));
      row.dataset.imagePaths = JSON.stringify(photos.map(item => item.storage_path));
      row.dataset.comments = JSON.stringify(commentsByRequest.get(request.id) || []);
      if (request.archived_at) archivedRows.push(row.outerHTML);
      else activeRows.push(row.outerHTML);
    }
    localStorage.setItem(KEYS.requests, activeRows.join(""));
    localStorage.setItem(KEYS.archived, archivedRows.join(""));
    localStorage.setItem(KEYS.history, "");
    localStorage.setItem("saitari-cloud-ready", "true");
    lastSnapshot = localSnapshot();
  }

  async function initializeCloud() {
    if (!window.supabase || typeof window.supabase.createClient !== "function") throw new Error("Δεν φορτώθηκε ο Supabase client.");
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    addStyles();
    progress("Σύνδεση με Supabase…");
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    activeUser = data.session?.user || null;
    if (!activeUser) {
      showAuth();
      await new Promise(resolve => {
        const subscription = client.auth.onAuthStateChange((event, session) => {
          if (event === "SIGNED_IN" && session?.user) {
            activeUser = session.user;
            subscription.data.subscription.unsubscribe();
            resolve();
          }
        });
      });
      document.querySelector(".saitari-auth-shade")?.remove();
    }
    const { data: profile, error: profileError } = await client.from("profiles")
      .select("user_id,email,display_name,role").eq("user_id", activeUser.id).single();
    if (profileError || !profile) throw profileError || new Error("Δεν βρέθηκε προφίλ χρήστη.");
    activeProfile = profile;
    addSignOut();

    progress("Φόρτωση δεδομένων…");
    const cloud = await fetchCloud();
    appProfiles = cloud.profiles;
    knownRequestIds = new Set(cloud.requests.map(item => item.id));
    knownCommentIds = new Set(cloud.comments.map(item => item.id));
    const cloudHasData = cloud.projects.length || cloud.requests.length;
    const localHasData = Boolean(localStorage.getItem(KEYS.projects) || localStorage.getItem(KEYS.requests) || localStorage.getItem(KEYS.archived));
    if (!cloudHasData && localHasData && activeProfile.role === "admin") {
      progress("Μεταφορά πελατών, αιτημάτων και εικόνων… Μην κλείσεις τη σελίδα.");
      await importLocalSnapshot();
      await hydrateLocal();
    } else if (cloudHasData || activeProfile.role === "client") {
      await hydrateLocal();
    } else {
      localStorage.setItem("saitari-cloud-ready", "true");
      localStorage.setItem("saitari-cloud-has-projects", "false");
      await backupLocal();
    }
    lastSnapshot = localSnapshot();
    document.querySelector(".saitari-cloud-progress")?.remove();
  }

  async function syncNow() {
    if (!activeUser || localStorage.getItem("saitari-cloud-ready") !== "true") return false;
    if (syncing) {
      for (let attempt = 0; attempt < 40 && syncing; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
      if (syncing) return false;
    }
    const current = localSnapshot();
    if (current === lastSnapshot) return true;
    syncing = true;
    try {
      await importLocalSnapshot();
      lastSnapshot = localSnapshot();
      document.querySelector(".saitari-cloud-warning")?.remove();
      return true;
    } catch (error) {
      console.error("Saitari Supabase sync failed", error);
      warn("Δεν συγχρονίστηκε ακόμη με το Supabase. Τα δεδομένα παραμένουν αποθηκευμένα σε αυτή τη συσκευή· έλεγξε τη σύνδεση και ξαναφόρτωσε τη σελίδα.");
      return false;
    } finally {
      syncing = false;
    }
  }

  function startWatching() {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(syncNow, 1800);
    window.addEventListener("storage", syncNow);
    window.addEventListener("beforeunload", syncNow);
  }

  function refreshSoon() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async function () {
      if (document.hidden || syncing) return;
      try {
        const cloud = await fetchCloud();
        const remoteStamp = cloud.requests.map(r => [r.id, r.status, r.completed_at, r.archived_at, r.title, r.description].join(":" )).join("") +
          cloud.projects.map(p => [p.id, p.name, p.status, p.updated_at].join(":" )).join("") +
          cloud.comments.map(c => [c.id, c.body, c.created_at].join(":" )).join("") +
          cloud.attachments.map(a => [a.id, a.storage_path].join(":" )).join("");
        if (remoteStamp && remoteStamp !== window.__saitariRemoteStamp) {
          window.__saitariRemoteStamp = remoteStamp;
          // Avoid replacing unsynced local edits in the middle of an interaction.
          if (localSnapshot() === lastSnapshot) {
            await hydrateLocal();
            lastSnapshot = localSnapshot();
          }
        }
      } catch (error) { console.warn("Could not refresh Saitari cloud data", error); }
    }, 15000);
  }

  const ready = initializeCloud().then(function () {
    setInterval(refreshSoon, 15000);
    return true;
  }).catch(function (error) {
    console.error("Saitari cloud initialization failed", error);
    addStyles();
    document.querySelector(".saitari-cloud-progress")?.remove();
    showAuth("Δεν ήταν δυνατή η σύνδεση με το Supabase. Έλεγξε ότι εκτελέστηκε το SQL setup και ότι ο χρήστης έχει δημιουργηθεί.");
    return false;
  });

  window.SaitariCloud = {
    ready, startWatching, syncNow,
    get role() { return activeProfile?.role || "client"; },
    get profile() { return activeProfile || null; },
    get profiles() { return appProfiles; }
  };
})();
