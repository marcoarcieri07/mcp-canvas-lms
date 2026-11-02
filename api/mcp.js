// api/mcp.js
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport as StreamableHTTPServerTransport2 } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// src/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

// src/client.ts
import axios from "axios";

// src/types.ts
var CanvasAPIError = class extends Error {
  constructor(message, statusCode, response) {
    super(message);
    this.statusCode = statusCode;
    this.response = response;
    this.name = "CanvasAPIError";
  }
};

// src/client.ts
var CanvasClient = class {
  constructor(token, domain, options) {
    this.maxRetries = 3;
    this.retryDelay = 1e3;
    this.baseURL = `https://${domain}/api/v1`;
    this.maxRetries = options?.maxRetries ?? 3;
    this.retryDelay = options?.retryDelay ?? 1e3;
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      timeout: 3e4
      // 30 second timeout
    });
    this.setupInterceptors();
  }
  setupInterceptors() {
    this.client.interceptors.request.use(
      (config2) => {
        console.error(`[Canvas API] ${config2.method?.toUpperCase()} ${config2.url}`);
        return config2;
      },
      (error) => {
        console.error("[Canvas API] Request error:", error.message || error);
        return Promise.reject(error);
      }
    );
    this.client.interceptors.response.use(
      async (response) => {
        const { headers, data } = response;
        const linkHeader = headers.link;
        const contentType = headers["content-type"] || "";
        if (Array.isArray(data) && linkHeader && contentType.includes("application/json")) {
          let allData = [...data];
          let nextUrl = this.getNextPageUrl(linkHeader);
          const paginationLimit = response.config.paginationLimit;
          const paginationConfig = {
            headers: response.config.headers,
            timeout: response.config.timeout ?? 3e4
          };
          while (nextUrl && (!paginationLimit || allData.length < paginationLimit)) {
            console.error(`[Canvas API] GET ${nextUrl}`);
            const nextResponse = await this.fetchPaginatedPage(nextUrl, paginationConfig);
            allData = [...allData, ...nextResponse.data];
            nextUrl = nextResponse.headers.link ? this.getNextPageUrl(nextResponse.headers.link) : null;
          }
          response.data = paginationLimit ? allData.slice(0, paginationLimit) : allData;
        }
        return response;
      },
      async (error) => {
        const config2 = error.config;
        const retryCount = config2?.__retryCount ?? 0;
        if (this.shouldRetry(error) && config2 && retryCount < this.maxRetries) {
          config2.__retryCount = retryCount + 1;
          const delay = this.retryDelay * Math.pow(2, config2.__retryCount - 1);
          console.error(`[Canvas API] Retrying request (${config2.__retryCount}/${this.maxRetries}) after ${delay}ms`);
          await this.sleep(delay);
          return this.client.request(config2);
        }
        this.throwCanvasAPIError(error);
      }
    );
  }
  async fetchPaginatedPage(url, config2) {
    let retryCount = 0;
    while (true) {
      try {
        return await axios.get(url, config2);
      } catch (error) {
        const axiosError = error;
        if (this.shouldRetry(axiosError) && retryCount < this.maxRetries) {
          retryCount++;
          const delay = this.retryDelay * Math.pow(2, retryCount - 1);
          console.error(`[Canvas API] Retrying pagination request (${retryCount}/${this.maxRetries}) after ${delay}ms`);
          await this.sleep(delay);
          continue;
        }
        this.throwCanvasAPIError(axiosError);
      }
    }
  }
  shouldRetry(error) {
    if (!error.response) return true;
    const status = error.response.status;
    return status === 429 || status >= 500;
  }
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  throwCanvasAPIError(error) {
    if (error.response) {
      const { status, data, headers } = error.response;
      const contentType = headers?.["content-type"] || "unknown";
      console.error(`[Canvas API] Error response: ${status}, Content-Type: ${contentType}, Data type: ${typeof data}`);
      let errorMessage;
      try {
        if (typeof data === "string") {
          errorMessage = data.length > 200 ? data.substring(0, 200) + "..." : data;
        } else if (data && typeof data === "object") {
          if (data?.message) {
            errorMessage = data.message;
          } else if (data?.errors && Array.isArray(data.errors)) {
            errorMessage = data.errors.map((err) => err.message || err).join(", ");
          } else {
            errorMessage = JSON.stringify(data);
          }
        } else {
          errorMessage = String(data);
        }
      } catch (jsonError) {
        errorMessage = String(data);
      }
      throw new CanvasAPIError(
        `Canvas API Error (${status}): ${errorMessage}`,
        status,
        data
      );
    }
    if (error.request) {
      console.error("[Canvas API] Network error - no response received:", error.message);
      throw new CanvasAPIError(
        `Network error: ${error.message}`,
        0,
        null
      );
    }
    console.error("[Canvas API] Unexpected error:", error.message);
    throw error;
  }
  getNextPageUrl(linkHeader) {
    const links = linkHeader.split(",");
    const nextLink = links.find((link) => link.includes('rel="next"'));
    if (!nextLink) return null;
    const match = nextLink.match(/<(.+?)>/);
    return match ? match[1] : null;
  }
  // ---------------------
  // HEALTH CHECK
  // ---------------------
  async healthCheck() {
    try {
      const user = await this.getUserProfile();
      return {
        status: "ok",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        user: { id: user.id, name: user.name }
      };
    } catch (error) {
      return {
        status: "error",
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
  }
  // ---------------------
  // COURSES (Enhanced)
  // ---------------------
  async listCourses(options = {}) {
    const opts = typeof options === "boolean" ? { includeEnded: options } : options;
    const { includeEnded = false, limit, enrollmentState } = opts;
    const paginationLimit = typeof limit === "number" && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : void 0;
    if (paginationLimit === 0) {
      return [];
    }
    const params = {
      include: ["total_students", "teachers", "term", "course_progress"]
    };
    if (!includeEnded) {
      params.state = ["available", "completed"];
    }
    if (enrollmentState) {
      params.enrollment_state = enrollmentState;
    }
    if (paginationLimit) {
      params.per_page = Math.min(paginationLimit, 100);
    }
    const response = await this.client.get("/courses", {
      params,
      paginationLimit
    });
    return response.data;
  }
  async getCourse(courseId) {
    const response = await this.client.get(`/courses/${courseId}`, {
      params: {
        include: ["total_students", "teachers", "term", "course_progress", "sections", "syllabus_body"]
      }
    });
    return response.data;
  }
  async createCourse(args) {
    const { account_id, ...courseData } = args;
    const response = await this.client.post(`/accounts/${account_id}/courses`, {
      course: courseData
    });
    return response.data;
  }
  async updateCourse(args) {
    const { course_id, ...courseData } = args;
    const response = await this.client.put(`/courses/${course_id}`, {
      course: courseData
    });
    return response.data;
  }
  async deleteCourse(courseId) {
    await this.client.delete(`/courses/${courseId}`);
  }
  // ---------------------
  // ASSIGNMENTS (Enhanced)
  // ---------------------
  async listAssignments(courseId, includeSubmissions = false) {
    const params = {
      include: ["assignment_group", "rubric", "due_at"]
    };
    if (includeSubmissions) {
      params.include.push("submission");
    }
    const response = await this.client.get(`/courses/${courseId}/assignments`, { params });
    return response.data;
  }
  async getAssignment(courseId, assignmentId, includeSubmission = false) {
    const params = {
      include: ["assignment_group", "rubric"]
    };
    if (includeSubmission) {
      params.include.push("submission");
    }
    const response = await this.client.get(`/courses/${courseId}/assignments/${assignmentId}`, { params });
    return response.data;
  }
  async createAssignment(args) {
    const { course_id, ...assignmentData } = args;
    const response = await this.client.post(`/courses/${course_id}/assignments`, {
      assignment: assignmentData
    });
    return response.data;
  }
  async updateAssignment(args) {
    const { course_id, assignment_id, ...assignmentData } = args;
    const response = await this.client.put(
      `/courses/${course_id}/assignments/${assignment_id}`,
      { assignment: assignmentData }
    );
    return response.data;
  }
  async deleteAssignment(courseId, assignmentId) {
    await this.client.delete(`/courses/${courseId}/assignments/${assignmentId}`);
  }
  // ---------------------
  // ASSIGNMENT GROUPS
  // ---------------------
  async listAssignmentGroups(courseId) {
    const response = await this.client.get(`/courses/${courseId}/assignment_groups`, {
      params: {
        include: ["assignments"]
      }
    });
    return response.data;
  }
  async getAssignmentGroup(courseId, groupId) {
    const response = await this.client.get(`/courses/${courseId}/assignment_groups/${groupId}`, {
      params: {
        include: ["assignments"]
      }
    });
    return response.data;
  }
  // ---------------------
  // SUBMISSIONS (Enhanced for Students)
  // ---------------------
  async getSubmissions(courseId, assignmentId) {
    const response = await this.client.get(
      `/courses/${courseId}/assignments/${assignmentId}/submissions`,
      {
        params: {
          include: ["submission_comments", "rubric_assessment", "assignment"]
        }
      }
    );
    return response.data;
  }
  async getSubmission(courseId, assignmentId, userId = "self") {
    const response = await this.client.get(
      `/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`,
      {
        params: {
          include: ["submission_comments", "rubric_assessment", "assignment"]
        }
      }
    );
    return response.data;
  }
  async submitGrade(args) {
    const { course_id, assignment_id, user_id, grade, comment } = args;
    const response = await this.client.put(
      `/courses/${course_id}/assignments/${assignment_id}/submissions/${user_id}`,
      {
        submission: {
          posted_grade: grade,
          comment: comment ? { text_comment: comment } : void 0
        }
      }
    );
    return response.data;
  }
  // Student submission with file support
  async submitAssignment(args) {
    const { course_id, assignment_id, submission_type, body, url, file_ids } = args;
    const submissionData = {
      submission_type
    };
    if (body) submissionData.body = body;
    if (url) submissionData.url = url;
    if (file_ids && file_ids.length > 0) submissionData.file_ids = file_ids;
    const response = await this.client.post(
      `/courses/${course_id}/assignments/${assignment_id}/submissions`,
      { submission: submissionData }
    );
    return response.data;
  }
  // ---------------------
  // FILES (Enhanced)
  // ---------------------
  async listFiles(courseId, folderId) {
    const endpoint = folderId ? `/folders/${folderId}/files` : `/courses/${courseId}/files`;
    const response = await this.client.get(endpoint);
    return response.data;
  }
  async getFile(fileId) {
    const response = await this.client.get(`/files/${fileId}`);
    return response.data;
  }
  async uploadFile(args) {
    const { course_id, folder_id, name, size } = args;
    const uploadEndpoint = folder_id ? `/folders/${folder_id}/files` : `/courses/${course_id}/files`;
    const uploadResponse = await this.client.post(uploadEndpoint, {
      name,
      size,
      content_type: args.content_type || "application/octet-stream"
    });
    return uploadResponse.data;
  }
  async listFolders(courseId) {
    const response = await this.client.get(`/courses/${courseId}/folders`);
    return response.data;
  }
  // ---------------------
  // PAGES
  // ---------------------
  async listPages(courseId) {
    const response = await this.client.get(`/courses/${courseId}/pages`);
    return response.data;
  }
  async getPage(courseId, pageUrl) {
    const response = await this.client.get(`/courses/${courseId}/pages/${pageUrl}`);
    return response.data;
  }
  // ---------------------
  // CALENDAR EVENTS
  // ---------------------
  async listCalendarEvents(startDate, endDate) {
    const params = {
      type: "event",
      all_events: true
    };
    if (startDate) params.start_date = startDate;
    if (endDate) params.end_date = endDate;
    const response = await this.client.get("/calendar_events", { params });
    return response.data;
  }
  async getUpcomingAssignments(limit = 10) {
    const response = await this.client.get("/users/self/upcoming_events", {
      params: { limit }
    });
    return response.data.filter((event) => event.assignment);
  }
  // ---------------------
  // RUBRICS
  // ---------------------
  async listRubrics(courseId) {
    const response = await this.client.get(`/courses/${courseId}/rubrics`);
    return response.data;
  }
  async getRubric(courseId, rubricId) {
    const response = await this.client.get(`/courses/${courseId}/rubrics/${rubricId}`);
    return response.data;
  }
  // ---------------------
  // DASHBOARD
  // ---------------------
  async getDashboard() {
    const response = await this.client.get("/users/self/dashboard");
    return response.data;
  }
  async getDashboardCards() {
    const response = await this.client.get("/dashboard/dashboard_cards");
    return response.data;
  }
  // ---------------------
  // SYLLABUS
  // ---------------------
  async getSyllabus(courseId) {
    const response = await this.client.get(`/courses/${courseId}`, {
      params: {
        include: ["syllabus_body"]
      }
    });
    return {
      course_id: courseId,
      syllabus_body: response.data.syllabus_body
    };
  }
  // ---------------------
  // CONVERSATIONS/MESSAGING
  // ---------------------
  async listConversations() {
    const response = await this.client.get("/conversations");
    return response.data;
  }
  async getConversation(conversationId) {
    const response = await this.client.get(`/conversations/${conversationId}`);
    return response.data;
  }
  async createConversation(recipients, body, subject) {
    const response = await this.client.post("/conversations", {
      recipients,
      body,
      subject
    });
    return response.data;
  }
  // ---------------------
  // NOTIFICATIONS
  // ---------------------
  async listNotifications() {
    const response = await this.client.get("/users/self/activity_stream");
    return response.data;
  }
  // ---------------------
  // USERS AND ENROLLMENTS (Enhanced)
  // ---------------------
  async listUsers(courseId) {
    const response = await this.client.get(`/courses/${courseId}/users`, {
      params: {
        include: ["email", "enrollments", "avatar_url"]
      }
    });
    return response.data;
  }
  async getEnrollments(courseId) {
    const response = await this.client.get(`/courses/${courseId}/enrollments`);
    return response.data;
  }
  async enrollUser(args) {
    const { course_id, user_id, role = "StudentEnrollment", enrollment_state = "active" } = args;
    const response = await this.client.post(`/courses/${course_id}/enrollments`, {
      enrollment: {
        user_id,
        type: role,
        enrollment_state
      }
    });
    return response.data;
  }
  async unenrollUser(courseId, enrollmentId) {
    await this.client.delete(`/courses/${courseId}/enrollments/${enrollmentId}`);
  }
  // ---------------------
  // GRADES (Enhanced)
  // ---------------------
  async getCourseGrades(courseId) {
    const response = await this.client.get(`/courses/${courseId}/enrollments`, {
      params: {
        include: ["grades", "observed_users"]
      }
    });
    return response.data;
  }
  async getUserGrades() {
    const response = await this.client.get("/users/self/grades");
    return response.data;
  }
  // ---------------------
  // USER PROFILE (Enhanced)
  // ---------------------
  async getUserProfile() {
    const response = await this.client.get("/users/self/profile");
    return response.data;
  }
  async updateUserProfile(profileData) {
    const response = await this.client.put("/users/self", {
      user: profileData
    });
    return response.data;
  }
  // ---------------------
  // STUDENT COURSES (Enhanced)
  // ---------------------
  async listStudentCourses() {
    const response = await this.client.get("/courses", {
      params: {
        include: ["enrollments", "total_students", "term", "course_progress"],
        enrollment_state: "active"
      }
    });
    return response.data;
  }
  // ---------------------
  // MODULES (Enhanced)
  // ---------------------
  async listModules(courseId) {
    const response = await this.client.get(`/courses/${courseId}/modules`, {
      params: {
        include: ["items"]
      }
    });
    return response.data;
  }
  async getModule(courseId, moduleId) {
    const response = await this.client.get(`/courses/${courseId}/modules/${moduleId}`, {
      params: {
        include: ["items"]
      }
    });
    return response.data;
  }
  async listModuleItems(courseId, moduleId) {
    const response = await this.client.get(`/courses/${courseId}/modules/${moduleId}/items`, {
      params: {
        include: ["content_details"]
      }
    });
    return response.data;
  }
  async getModuleItem(courseId, moduleId, itemId) {
    const response = await this.client.get(`/courses/${courseId}/modules/${moduleId}/items/${itemId}`, {
      params: {
        include: ["content_details"]
      }
    });
    return response.data;
  }
  async markModuleItemComplete(courseId, moduleId, itemId) {
    await this.client.put(`/courses/${courseId}/modules/${moduleId}/items/${itemId}/done`);
  }
  // ---------------------
  // DISCUSSION TOPICS (Enhanced)
  // ---------------------
  async listDiscussionTopics(courseId) {
    const response = await this.client.get(`/courses/${courseId}/discussion_topics`, {
      params: {
        include: ["assignment"]
      }
    });
    return response.data;
  }
  async getDiscussionTopic(courseId, topicId) {
    const response = await this.client.get(`/courses/${courseId}/discussion_topics/${topicId}`, {
      params: {
        include: ["assignment"]
      }
    });
    return response.data;
  }
  async postToDiscussion(courseId, topicId, message) {
    const response = await this.client.post(`/courses/${courseId}/discussion_topics/${topicId}/entries`, {
      message
    });
    return response.data;
  }
  // ---------------------
  // ANNOUNCEMENTS (Enhanced)
  // ---------------------
  async listAnnouncements(courseId) {
    const response = await this.client.get(`/courses/${courseId}/discussion_topics`, {
      params: {
        type: "announcement",
        include: ["assignment"]
      }
    });
    return response.data;
  }
  // ---------------------
  // QUIZZES (Enhanced)
  // ---------------------
  async listQuizzes(courseId) {
    const response = await this.client.get(`/courses/${courseId}/quizzes`);
    return response.data;
  }
  async getQuiz(courseId, quizId) {
    const response = await this.client.get(`/courses/${courseId}/quizzes/${quizId}`);
    return response.data;
  }
  async createQuiz(courseId, quizData) {
    const response = await this.client.post(`/courses/${courseId}/quizzes`, {
      quiz: quizData
    });
    return response.data;
  }
  async updateQuiz(courseId, quizId, quizData) {
    const response = await this.client.put(`/courses/${courseId}/quizzes/${quizId}`, {
      quiz: quizData
    });
    return response.data;
  }
  async deleteQuiz(courseId, quizId) {
    await this.client.delete(`/courses/${courseId}/quizzes/${quizId}`);
  }
  async startQuizAttempt(courseId, quizId) {
    const response = await this.client.post(`/courses/${courseId}/quizzes/${quizId}/submissions`);
    return response.data;
  }
  async submitQuizAttempt(courseId, quizId, submissionId, answers) {
    const response = await this.client.post(
      `/courses/${courseId}/quizzes/${quizId}/submissions/${submissionId}/complete`,
      { quiz_submissions: [{ attempt: 1, questions: answers }] }
    );
    return response.data;
  }
  // ---------------------
  // SCOPES (Enhanced)
  // ---------------------
  async listTokenScopes(accountId, groupBy) {
    const params = {};
    if (groupBy) {
      params.group_by = groupBy;
    }
    const response = await this.client.get(`/accounts/${accountId}/scopes`, { params });
    return response.data;
  }
  // ---------------------
  // ACCOUNT MANAGEMENT (New)
  // ---------------------
  async getAccount(accountId) {
    const response = await this.client.get(`/accounts/${accountId}`);
    return response.data;
  }
  async listAccountCourses(args) {
    const { account_id, ...params } = args;
    const response = await this.client.get(`/accounts/${account_id}/courses`, { params });
    return response.data;
  }
  async listAccountUsers(args) {
    const { account_id, ...params } = args;
    const response = await this.client.get(`/accounts/${account_id}/users`, { params });
    return response.data;
  }
  async createUser(args) {
    const { account_id, ...userData } = args;
    const response = await this.client.post(`/accounts/${account_id}/users`, userData);
    return response.data;
  }
  async listSubAccounts(accountId) {
    const response = await this.client.get(`/accounts/${accountId}/sub_accounts`);
    return response.data;
  }
  // ---------------------
  // ACCOUNT REPORTS (New)
  // ---------------------
  async getAccountReports(accountId) {
    const response = await this.client.get(`/accounts/${accountId}/reports`);
    return response.data;
  }
  async createAccountReport(args) {
    const { account_id, report, parameters } = args;
    const response = await this.client.post(`/accounts/${account_id}/reports/${report}`, {
      parameters: parameters || {}
    });
    return response.data;
  }
  async getAccountReport(accountId, reportType, reportId) {
    const response = await this.client.get(`/accounts/${accountId}/reports/${reportType}/${reportId}`);
    return response.data;
  }
};

// src/index.ts
import * as dotenv from "dotenv";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
var RAW_TOOLS = [
  // Health and system tools
  {
    name: "canvas_health_check",
    description: "Check the health and connectivity of the Canvas API",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  // Course management
  {
    name: "canvas_list_courses",
    description: "List all courses for the current user",
    inputSchema: {
      type: "object",
      properties: {
        include_ended: { type: "boolean", description: "Include ended courses" },
        limit: { type: "number", description: "Max number of courses to return (default: all)" },
        enrollment_state: { type: "string", enum: ["active", "invited_or_pending", "completed"], description: "Filter by enrollment state" },
        slim: { type: "boolean", description: "Return only id, name, course_code, term name, and workflow_state" }
      },
      required: []
    }
  },
  {
    name: "canvas_get_course",
    description: "Get detailed information about a specific course",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" }
      },
      required: ["course_id"]
    }
  },
  {
    name: "canvas_create_course",
    description: "Create a new course in Canvas",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "number", description: "ID of the account to create the course in" },
        name: { type: "string", description: "Name of the course" },
        course_code: { type: "string", description: "Course code (e.g., CS101)" },
        start_at: { type: "string", description: "Course start date (ISO format)" },
        end_at: { type: "string", description: "Course end date (ISO format)" },
        license: { type: "string", description: "Course license" },
        is_public: { type: "boolean", description: "Whether the course is public" },
        is_public_to_auth_users: { type: "boolean", description: "Whether the course is public to authenticated users" },
        public_syllabus: { type: "boolean", description: "Whether the syllabus is public" },
        public_syllabus_to_auth: { type: "boolean", description: "Whether the syllabus is public to authenticated users" },
        public_description: { type: "string", description: "Public description of the course" },
        allow_student_wiki_edits: { type: "boolean", description: "Whether students can edit the wiki" },
        allow_wiki_comments: { type: "boolean", description: "Whether wiki comments are allowed" },
        allow_student_forum_attachments: { type: "boolean", description: "Whether students can add forum attachments" },
        open_enrollment: { type: "boolean", description: "Whether the course has open enrollment" },
        self_enrollment: { type: "boolean", description: "Whether the course allows self enrollment" },
        restrict_enrollments_to_course_dates: { type: "boolean", description: "Whether to restrict enrollments to course start/end dates" },
        term_id: { type: "number", description: "ID of the enrollment term" },
        sis_course_id: { type: "string", description: "SIS course ID" },
        integration_id: { type: "string", description: "Integration ID for the course" },
        hide_final_grades: { type: "boolean", description: "Whether to hide final grades" },
        apply_assignment_group_weights: { type: "boolean", description: "Whether to apply assignment group weights" },
        time_zone: { type: "string", description: "Course time zone" },
        syllabus_body: { type: "string", description: "Course syllabus content" }
      },
      required: ["account_id", "name"]
    }
  },
  {
    name: "canvas_update_course",
    description: "Update an existing course in Canvas",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course to update" },
        name: { type: "string", description: "New name for the course" },
        course_code: { type: "string", description: "New course code" },
        start_at: { type: "string", description: "New start date (ISO format)" },
        end_at: { type: "string", description: "New end date (ISO format)" },
        license: { type: "string", description: "Course license" },
        is_public: { type: "boolean", description: "Whether the course is public" },
        is_public_to_auth_users: { type: "boolean", description: "Whether the course is public to authenticated users" },
        public_syllabus: { type: "boolean", description: "Whether the syllabus is public" },
        public_syllabus_to_auth: { type: "boolean", description: "Whether the syllabus is public to authenticated users" },
        public_description: { type: "string", description: "Public description of the course" },
        allow_student_wiki_edits: { type: "boolean", description: "Whether students can edit the wiki" },
        allow_wiki_comments: { type: "boolean", description: "Whether wiki comments are allowed" },
        allow_student_forum_attachments: { type: "boolean", description: "Whether students can add forum attachments" },
        open_enrollment: { type: "boolean", description: "Whether the course has open enrollment" },
        self_enrollment: { type: "boolean", description: "Whether the course allows self enrollment" },
        restrict_enrollments_to_course_dates: { type: "boolean", description: "Whether to restrict enrollments to course start/end dates" },
        hide_final_grades: { type: "boolean", description: "Whether to hide final grades" },
        apply_assignment_group_weights: { type: "boolean", description: "Whether to apply assignment group weights" },
        time_zone: { type: "string", description: "Course time zone" },
        syllabus_body: { type: "string", description: "Updated syllabus content" }
      },
      required: ["course_id"]
    }
  },
  // Assignment management
  {
    name: "canvas_list_assignments",
    description: "List assignments for a course",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        include_submissions: { type: "boolean", description: "Include submission data" }
      },
      required: ["course_id"]
    }
  },
  {
    name: "canvas_get_assignment",
    description: "Get detailed information about a specific assignment",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        assignment_id: { type: "number", description: "ID of the assignment" },
        include_submission: { type: "boolean", description: "Include user's submission data" }
      },
      required: ["course_id", "assignment_id"]
    }
  },
  {
    name: "canvas_create_assignment",
    description: "Create a new assignment in a Canvas course",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        name: { type: "string", description: "Name of the assignment" },
        description: { type: "string", description: "Assignment description/instructions" },
        due_at: { type: "string", description: "Due date (ISO format)" },
        points_possible: { type: "number", description: "Maximum points possible" },
        submission_types: {
          type: "array",
          items: { type: "string" },
          description: "Allowed submission types"
        },
        allowed_extensions: {
          type: "array",
          items: { type: "string" },
          description: "Allowed file extensions for submissions"
        },
        published: { type: "boolean", description: "Whether the assignment is published" }
      },
      required: ["course_id", "name"]
    }
  },
  {
    name: "canvas_update_assignment",
    description: "Update an existing assignment",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        assignment_id: { type: "number", description: "ID of the assignment to update" },
        name: { type: "string", description: "New name for the assignment" },
        description: { type: "string", description: "New assignment description" },
        due_at: { type: "string", description: "New due date (ISO format)" },
        points_possible: { type: "number", description: "New maximum points" },
        published: { type: "boolean", description: "Whether the assignment is published" }
      },
      required: ["course_id", "assignment_id"]
    }
  },
  // Assignment groups
  {
    name: "canvas_list_assignment_groups",
    description: "List assignment groups for a course",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" }
      },
      required: ["course_id"]
    }
  },
  // Submissions and grading
  {
    name: "canvas_get_submission",
    description: "Get submission details for an assignment",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        assignment_id: { type: "number", description: "ID of the assignment" },
        user_id: { type: "number", description: "ID of the user (optional, defaults to self)" }
      },
      required: ["course_id", "assignment_id"]
    }
  },
  {
    name: "canvas_submit_assignment",
    description: "Submit work for an assignment",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        assignment_id: { type: "number", description: "ID of the assignment" },
        submission_type: {
          type: "string",
          enum: ["online_text_entry", "online_url", "online_upload"],
          description: "Type of submission"
        },
        body: { type: "string", description: "Text content for text submissions" },
        url: { type: "string", description: "URL for URL submissions" },
        file_ids: {
          type: "array",
          items: { type: "number" },
          description: "File IDs for file submissions"
        }
      },
      required: ["course_id", "assignment_id", "submission_type"]
    }
  },
  {
    name: "canvas_submit_grade",
    description: "Submit a grade for a student's assignment (teacher only)",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        assignment_id: { type: "number", description: "ID of the assignment" },
        user_id: { type: "number", description: "ID of the student" },
        grade: {
          oneOf: [
            { type: "number" },
            { type: "string" }
          ],
          description: "Grade to submit (number or letter grade)"
        },
        comment: { type: "string", description: "Optional comment on the submission" }
      },
      required: ["course_id", "assignment_id", "user_id", "grade"]
    }
  },
  // Files and uploads
  {
    name: "canvas_list_files",
    description: "List files in a course or folder",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        folder_id: { type: "number", description: "ID of the folder (optional)" }
      },
      required: ["course_id"]
    }
  },
  {
    name: "canvas_get_file",
    description: "Get information about a specific file",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "number", description: "ID of the file" }
      },
      required: ["file_id"]
    }
  },
  {
    name: "canvas_list_folders",
    description: "List folders in a course",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" }
      },
      required: ["course_id"]
    }
  },
  // Pages
  {
    name: "canvas_list_pages",
    description: "List pages in a course",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" }
      },
      required: ["course_id"]
    }
  },
  {
    name: "canvas_get_page",
    description: "Get content of a specific page",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        page_url: { type: "string", description: "URL slug of the page" }
      },
      required: ["course_id", "page_url"]
    }
  },
  // Calendar and due dates
  {
    name: "canvas_list_calendar_events",
    description: "List calendar events",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date (ISO format)" },
        end_date: { type: "string", description: "End date (ISO format)" }
      },
      required: []
    }
  },
  {
    name: "canvas_get_upcoming_assignments",
    description: "Get upcoming assignment due dates",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of assignments to return" }
      },
      required: []
    }
  },
  // Dashboard
  {
    name: "canvas_get_dashboard",
    description: "Get user's dashboard information",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "canvas_get_dashboard_cards",
    description: "Get dashboard course cards",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  // Grades
  {
    name: "canvas_get_course_grades",
    description: "Get grades for a course",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" }
      },
      required: ["course_id"]
    }
  },
  {
    name: "canvas_get_user_grades",
    description: "Get all grades for the current user",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  // User management
  {
    name: "canvas_get_user_profile",
    description: "Get current user's profile",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "canvas_update_user_profile",
    description: "Update current user's profile",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "User's name" },
        short_name: { type: "string", description: "User's short name" },
        bio: { type: "string", description: "User's bio" },
        title: { type: "string", description: "User's title" },
        time_zone: { type: "string", description: "User's time zone" }
      },
      required: []
    }
  },
  {
    name: "canvas_enroll_user",
    description: "Enroll a user in a course",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        user_id: { type: "number", description: "ID of the user to enroll" },
        role: {
          type: "string",
          description: "Role for the enrollment (StudentEnrollment, TeacherEnrollment, etc.)"
        },
        enrollment_state: {
          type: "string",
          description: "State of the enrollment (active, invited, etc.)"
        }
      },
      required: ["course_id", "user_id"]
    }
  },
  // Modules
  {
    name: "canvas_list_modules",
    description: "List all modules in a course",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" }
      },
      required: ["course_id"]
    }
  },
  {
    name: "canvas_get_module",
    description: "Get details of a specific module",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        module_id: { type: "number", description: "ID of the module" }
      },
      required: ["course_id", "module_id"]
    }
  },
  {
    name: "canvas_list_module_items",
    description: "List all items in a module",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        module_id: { type: "number", description: "ID of the module" }
      },
      required: ["course_id", "module_id"]
    }
  },
  {
    name: "canvas_get_module_item",
    description: "Get details of a specific module item",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        module_id: { type: "number", description: "ID of the module" },
        item_id: { type: "number", description: "ID of the module item" }
      },
      required: ["course_id", "module_id", "item_id"]
    }
  },
  {
    name: "canvas_mark_module_item_complete",
    description: "Mark a module item as complete",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        module_id: { type: "number", description: "ID of the module" },
        item_id: { type: "number", description: "ID of the module item" }
      },
      required: ["course_id", "module_id", "item_id"]
    }
  },
  // Discussions
  {
    name: "canvas_list_discussion_topics",
    description: "List all discussion topics in a course",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" }
      },
      required: ["course_id"]
    }
  },
  {
    name: "canvas_get_discussion_topic",
    description: "Get details of a specific discussion topic",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        topic_id: { type: "number", description: "ID of the discussion topic" }
      },
      required: ["course_id", "topic_id"]
    }
  },
  {
    name: "canvas_post_to_discussion",
    description: "Post a message to a discussion topic",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        topic_id: { type: "number", description: "ID of the discussion topic" },
        message: { type: "string", description: "Message content" }
      },
      required: ["course_id", "topic_id", "message"]
    }
  },
  // Announcements
  {
    name: "canvas_list_announcements",
    description: "List all announcements in a course",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" }
      },
      required: ["course_id"]
    }
  },
  // Quizzes
  {
    name: "canvas_list_quizzes",
    description: "List all quizzes in a course",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" }
      },
      required: ["course_id"]
    }
  },
  {
    name: "canvas_get_quiz",
    description: "Get details of a specific quiz",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        quiz_id: { type: "number", description: "ID of the quiz" }
      },
      required: ["course_id", "quiz_id"]
    }
  },
  {
    name: "canvas_create_quiz",
    description: "Create a new quiz in a course",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        title: { type: "string", description: "Title of the quiz" },
        quiz_type: { type: "string", description: "Type of the quiz (e.g., graded)" },
        time_limit: { type: "number", description: "Time limit in minutes" },
        published: { type: "boolean", description: "Is the quiz published" },
        description: { type: "string", description: "Description of the quiz" },
        due_at: { type: "string", description: "Due date (ISO format)" }
      },
      required: ["course_id", "title"]
    }
  },
  {
    name: "canvas_start_quiz_attempt",
    description: "Start a new quiz attempt",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        quiz_id: { type: "number", description: "ID of the quiz" }
      },
      required: ["course_id", "quiz_id"]
    }
  },
  // Rubrics
  {
    name: "canvas_list_rubrics",
    description: "List rubrics for a course",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" }
      },
      required: ["course_id"]
    }
  },
  {
    name: "canvas_get_rubric",
    description: "Get details of a specific rubric",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" },
        rubric_id: { type: "number", description: "ID of the rubric" }
      },
      required: ["course_id", "rubric_id"]
    }
  },
  // Conversations
  {
    name: "canvas_list_conversations",
    description: "List user's conversations",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "canvas_get_conversation",
    description: "Get details of a specific conversation",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "number", description: "ID of the conversation" }
      },
      required: ["conversation_id"]
    }
  },
  {
    name: "canvas_create_conversation",
    description: "Create a new conversation",
    inputSchema: {
      type: "object",
      properties: {
        recipients: {
          type: "array",
          items: { type: "string" },
          description: "Recipient user IDs or email addresses"
        },
        body: { type: "string", description: "Message body" },
        subject: { type: "string", description: "Message subject" }
      },
      required: ["recipients", "body"]
    }
  },
  // Notifications
  {
    name: "canvas_list_notifications",
    description: "List user's notifications",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  // Syllabus
  {
    name: "canvas_get_syllabus",
    description: "Get course syllabus",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "number", description: "ID of the course" }
      },
      required: ["course_id"]
    }
  },
  // Account Management
  {
    name: "canvas_get_account",
    description: "Get account details",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "number", description: "ID of the account" }
      },
      required: ["account_id"]
    }
  },
  {
    name: "canvas_list_account_courses",
    description: "List courses for an account",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "number", description: "ID of the account" },
        with_enrollments: { type: "boolean", description: "Include enrollment data" },
        published: { type: "boolean", description: "Only include published courses" },
        completed: { type: "boolean", description: "Include completed courses" },
        search_term: { type: "string", description: "Search term to filter courses" },
        sort: { type: "string", enum: ["course_name", "sis_course_id", "teacher", "account_name"], description: "Sort order" },
        order: { type: "string", enum: ["asc", "desc"], description: "Sort direction" }
      },
      required: ["account_id"]
    }
  },
  {
    name: "canvas_list_account_users",
    description: "List users for an account",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "number", description: "ID of the account" },
        search_term: { type: "string", description: "Search term to filter users" },
        sort: { type: "string", enum: ["username", "email", "sis_id", "last_login"], description: "Sort order" },
        order: { type: "string", enum: ["asc", "desc"], description: "Sort direction" }
      },
      required: ["account_id"]
    }
  },
  {
    name: "canvas_create_user",
    description: "Create a new user in an account",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "number", description: "ID of the account" },
        user: {
          type: "object",
          properties: {
            name: { type: "string", description: "Full name of the user" },
            short_name: { type: "string", description: "Short name of the user" },
            sortable_name: { type: "string", description: "Sortable name (Last, First)" },
            time_zone: { type: "string", description: "User's time zone" }
          },
          required: ["name"]
        },
        pseudonym: {
          type: "object",
          properties: {
            unique_id: { type: "string", description: "Unique login ID (email or username)" },
            password: { type: "string", description: "User's password" },
            sis_user_id: { type: "string", description: "SIS ID for the user" },
            send_confirmation: { type: "boolean", description: "Send confirmation email" }
          },
          required: ["unique_id"]
        }
      },
      required: ["account_id", "user", "pseudonym"]
    }
  },
  {
    name: "canvas_list_sub_accounts",
    description: "List sub-accounts for an account",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "number", description: "ID of the parent account" }
      },
      required: ["account_id"]
    }
  },
  {
    name: "canvas_get_account_reports",
    description: "List available reports for an account",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "number", description: "ID of the account" }
      },
      required: ["account_id"]
    }
  },
  {
    name: "canvas_create_account_report",
    description: "Generate a report for an account",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "number", description: "ID of the account" },
        report: { type: "string", description: "Type of report to generate" },
        parameters: { type: "object", description: "Report parameters" }
      },
      required: ["account_id", "report"]
    }
  }
];
var READ_ONLY_TOOL_PREFIXES = ["canvas_list_", "canvas_get_", "canvas_health_check"];
var MUTATING_TOOL_PREFIXES = [
  "canvas_create_",
  "canvas_update_",
  "canvas_submit_",
  "canvas_enroll_",
  "canvas_mark_",
  "canvas_post_",
  "canvas_start_"
];
function toCommaList(values) {
  if (values.length === 0) {
    return "none";
  }
  return values.join(", ");
}
function getInputSchema(tool) {
  return tool.inputSchema ?? {};
}
function getRequiredFields(tool) {
  const schema = getInputSchema(tool);
  const required = schema.required;
  return Array.isArray(required) ? required.filter((value) => typeof value === "string") : [];
}
function getDefaultFields(tool) {
  const schema = getInputSchema(tool);
  const properties = schema.properties;
  if (!properties) {
    return [];
  }
  return Object.entries(properties).filter(([, property]) => {
    if (!property || typeof property !== "object") {
      return false;
    }
    return Object.prototype.hasOwnProperty.call(property, "default");
  }).map(([name]) => name);
}
function isReadOnlyTool(name) {
  return READ_ONLY_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}
function isMutatingTool(name) {
  return MUTATING_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}
function optimizeToolDescription(tool) {
  const required = getRequiredFields(tool);
  const defaults = getDefaultFields(tool);
  const sideEffect = isReadOnlyTool(tool.name) ? "No Canvas state is modified." : "This operation can modify Canvas state.";
  const latencyHint = isReadOnlyTool(tool.name) ? "Latency depends on Canvas API response time." : "May incur extra latency due to writes and Canvas-side processing.";
  return [
    tool.description ?? "Canvas LMS tool",
    `Required fields: ${toCommaList(required)}.`,
    `Defaults: ${defaults.length > 0 ? defaults.join(", ") : "none"}.`,
    sideEffect,
    latencyHint,
    "Use include_raw=true only when full provider payload is required."
  ].join(" ");
}
function optimizeToolAnnotations(toolName) {
  if (isReadOnlyTool(toolName)) {
    return {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true
    };
  }
  if (isMutatingTool(toolName)) {
    return {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true
    };
  }
  return {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true
  };
}
function optimizeToolInputSchema(tool) {
  const schema = getInputSchema(tool);
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const optimizedProperties = {
    ...properties
  };
  if (!Object.prototype.hasOwnProperty.call(optimizedProperties, "include_raw")) {
    optimizedProperties.include_raw = {
      type: "boolean",
      default: false,
      description: "When true, return full raw Canvas API payload for this tool call."
    };
  }
  return {
    type: "object",
    ...schema,
    properties: optimizedProperties,
    required,
    additionalProperties: false
  };
}
var TOOLS = RAW_TOOLS.map((tool) => ({
  ...tool,
  description: optimizeToolDescription(tool),
  inputSchema: optimizeToolInputSchema(tool),
  annotations: optimizeToolAnnotations(tool.name)
}));
var CanvasMCPServer = class {
  constructor(config2, client) {
    this.config = config2;
    this.client = client ?? new CanvasClient(
      config2.canvas.token,
      config2.canvas.domain,
      {
        maxRetries: config2.canvas.maxRetries,
        retryDelay: config2.canvas.retryDelay
      }
    );
    this.server = new Server(
      {
        name: config2.name,
        version: config2.version
      },
      {
        capabilities: {
          resources: {},
          tools: {}
        }
      }
    );
    this.setupHandlers();
    this.setupErrorHandling();
  }
  setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error(`[${this.config.name} Error]`, error);
    };
  }
  serializeToolOutput(payload, includeRaw) {
    if (includeRaw) {
      return JSON.stringify(payload, null, 2);
    }
    if (Array.isArray(payload)) {
      return JSON.stringify(
        {
          count: payload.length,
          items: payload.slice(0, 5),
          has_more: payload.length > 5
        },
        null,
        2
      );
    }
    return JSON.stringify(payload, null, 2);
  }
  isRetryable(error) {
    if (error instanceof CanvasAPIError && typeof error.statusCode === "number") {
      return error.statusCode === 429 || error.statusCode >= 500;
    }
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes("timeout") || message.includes("temporarily") || message.includes("rate limit");
  }
  toStructuredToolError(toolName, error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Missing required field") || message.startsWith("Missing required fields")) {
      return {
        status: "error",
        retryable: false,
        suggestion: "Provide all required fields shown in tools/list inputSchema and retry.",
        message,
        code: "validation_error",
        tool: toolName
      };
    }
    if (message.startsWith("Unknown tool")) {
      return {
        status: "error",
        retryable: false,
        suggestion: "Call tools/list and use an exact tool name from that list.",
        message,
        code: "unknown_tool",
        tool: toolName
      };
    }
    if (error instanceof CanvasAPIError) {
      return {
        status: "error",
        retryable: this.isRetryable(error),
        suggestion: "Verify Canvas permissions, account/course IDs, and retry for transient Canvas failures.",
        message,
        code: "canvas_api_error",
        tool: toolName
      };
    }
    return {
      status: "error",
      retryable: this.isRetryable(error),
      suggestion: "Review input values and server logs, then retry.",
      message,
      code: "internal_error",
      tool: toolName
    };
  }
  setupHandlers() {
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      try {
        const courses = await this.client.listCourses();
        return {
          resources: [
            {
              uri: "canvas://health",
              name: "Canvas Health Status",
              description: "Health check and API connectivity status",
              mimeType: "application/json"
            },
            {
              uri: "courses://list",
              name: "All Courses",
              description: "List of all available Canvas courses",
              mimeType: "application/json"
            },
            ...courses.map((course) => ({
              uri: `course://${course.id}`,
              name: `Course: ${course.name}`,
              description: `${course.course_code} - ${course.name}`,
              mimeType: "application/json"
            })),
            ...courses.map((course) => ({
              uri: `assignments://${course.id}`,
              name: `Assignments: ${course.name}`,
              description: `Assignments for ${course.name}`,
              mimeType: "application/json"
            })),
            ...courses.map((course) => ({
              uri: `modules://${course.id}`,
              name: `Modules: ${course.name}`,
              description: `Modules for ${course.name}`,
              mimeType: "application/json"
            })),
            ...courses.map((course) => ({
              uri: `discussions://${course.id}`,
              name: `Discussions: ${course.name}`,
              description: `Discussion topics for ${course.name}`,
              mimeType: "application/json"
            })),
            ...courses.map((course) => ({
              uri: `announcements://${course.id}`,
              name: `Announcements: ${course.name}`,
              description: `Announcements for ${course.name}`,
              mimeType: "application/json"
            })),
            ...courses.map((course) => ({
              uri: `quizzes://${course.id}`,
              name: `Quizzes: ${course.name}`,
              description: `Quizzes for ${course.name}`,
              mimeType: "application/json"
            })),
            ...courses.map((course) => ({
              uri: `pages://${course.id}`,
              name: `Pages: ${course.name}`,
              description: `Pages for ${course.name}`,
              mimeType: "application/json"
            })),
            ...courses.map((course) => ({
              uri: `files://${course.id}`,
              name: `Files: ${course.name}`,
              description: `Files for ${course.name}`,
              mimeType: "application/json"
            })),
            {
              uri: "dashboard://user",
              name: "User Dashboard",
              description: "User's Canvas dashboard information",
              mimeType: "application/json"
            },
            {
              uri: "profile://user",
              name: "User Profile",
              description: "Current user's profile information",
              mimeType: "application/json"
            },
            {
              uri: "calendar://upcoming",
              name: "Upcoming Events",
              description: "Upcoming assignments and events",
              mimeType: "application/json"
            }
          ]
        };
      } catch (error) {
        console.error("Error listing resources:", error);
        return { resources: [] };
      }
    });
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const [type, id] = uri.split("://");
      try {
        let content;
        switch (type) {
          case "canvas":
            if (id === "health") {
              content = await this.client.healthCheck();
            }
            break;
          case "courses":
            content = await this.client.listCourses();
            break;
          case "course":
            content = await this.client.getCourse(parseInt(id));
            break;
          case "assignments":
            content = await this.client.listAssignments(parseInt(id), true);
            break;
          case "modules":
            content = await this.client.listModules(parseInt(id));
            break;
          case "discussions":
            content = await this.client.listDiscussionTopics(parseInt(id));
            break;
          case "announcements":
            content = await this.client.listAnnouncements(id);
            break;
          case "quizzes":
            content = await this.client.listQuizzes(id);
            break;
          case "pages":
            content = await this.client.listPages(parseInt(id));
            break;
          case "files":
            content = await this.client.listFiles(parseInt(id));
            break;
          case "dashboard":
            if (id === "user") {
              content = await this.client.getDashboard();
            }
            break;
          case "profile":
            if (id === "user") {
              content = await this.client.getUserProfile();
            }
            break;
          case "calendar":
            if (id === "upcoming") {
              content = await this.client.getUpcomingAssignments();
            }
            break;
          default:
            throw new Error(`Unknown resource type: ${type}`);
        }
        return {
          contents: [{
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(content, null, 2)
          }]
        };
      } catch (error) {
        console.error(`Error reading resource ${uri}:`, error);
        return {
          contents: [{
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)
          }]
        };
      }
    });
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS
    }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const rawArgs = request.params.arguments ?? {};
        const includeRaw = rawArgs.include_raw === true;
        const { include_raw: _includeRaw, ...args } = rawArgs;
        const toolName = request.params.name;
        console.error(`[Canvas MCP] Executing tool: ${toolName}`);
        switch (toolName) {
          // Health check
          case "canvas_health_check": {
            const health = await this.client.healthCheck();
            return {
              content: [{ type: "text", text: this.serializeToolOutput(health, includeRaw) }]
            };
          }
          // Course management
          case "canvas_list_courses": {
            const { include_ended = false, limit, enrollment_state, slim = false } = args;
            const courses = await this.client.listCourses({ includeEnded: include_ended, limit, enrollmentState: enrollment_state });
            if (slim) {
              const slimCourses = courses.map((c) => ({
                id: c.id,
                name: c.name,
                course_code: c.course_code,
                term: c.term?.name,
                workflow_state: c.workflow_state
              }));
              return { content: [{ type: "text", text: JSON.stringify(slimCourses, null, 2) }] };
            }
            return {
              content: [{ type: "text", text: this.serializeToolOutput(courses, includeRaw) }]
            };
          }
          case "canvas_get_course": {
            const { course_id } = args;
            if (!course_id) throw new Error("Missing required field: course_id");
            const course = await this.client.getCourse(course_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(course, includeRaw) }]
            };
          }
          case "canvas_create_course": {
            const courseArgs = args;
            if (!courseArgs.account_id || !courseArgs.name) {
              throw new Error("Missing required fields: account_id and name");
            }
            const course = await this.client.createCourse(courseArgs);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(course, includeRaw) }]
            };
          }
          case "canvas_update_course": {
            const updateArgs = args;
            if (!updateArgs.course_id) {
              throw new Error("Missing required field: course_id");
            }
            const updatedCourse = await this.client.updateCourse(updateArgs);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(updatedCourse, includeRaw) }]
            };
          }
          // Assignment management
          case "canvas_list_assignments": {
            const { course_id, include_submissions = false } = args;
            if (!course_id) throw new Error("Missing required field: course_id");
            const assignments = await this.client.listAssignments(course_id, include_submissions);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(assignments, includeRaw) }]
            };
          }
          case "canvas_get_assignment": {
            const { course_id, assignment_id, include_submission = false } = args;
            if (!course_id || !assignment_id) {
              throw new Error("Missing required fields: course_id and assignment_id");
            }
            const assignment = await this.client.getAssignment(course_id, assignment_id, include_submission);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(assignment, includeRaw) }]
            };
          }
          case "canvas_create_assignment": {
            const assignmentArgs = args;
            if (!assignmentArgs.course_id || !assignmentArgs.name) {
              throw new Error("Missing required fields: course_id and name");
            }
            const assignment = await this.client.createAssignment(assignmentArgs);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(assignment, includeRaw) }]
            };
          }
          case "canvas_update_assignment": {
            const updateAssignmentArgs = args;
            if (!updateAssignmentArgs.course_id || !updateAssignmentArgs.assignment_id) {
              throw new Error("Missing required fields: course_id and assignment_id");
            }
            const updatedAssignment = await this.client.updateAssignment(updateAssignmentArgs);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(updatedAssignment, includeRaw) }]
            };
          }
          case "canvas_list_assignment_groups": {
            const { course_id } = args;
            if (!course_id) throw new Error("Missing required field: course_id");
            const groups = await this.client.listAssignmentGroups(course_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(groups, includeRaw) }]
            };
          }
          // Submissions
          case "canvas_get_submission": {
            const { course_id, assignment_id, user_id } = args;
            if (!course_id || !assignment_id) {
              throw new Error("Missing required fields: course_id and assignment_id");
            }
            const submission = await this.client.getSubmission(course_id, assignment_id, user_id || "self");
            return {
              content: [{ type: "text", text: this.serializeToolOutput(submission, includeRaw) }]
            };
          }
          case "canvas_submit_assignment": {
            const submitArgs = args;
            const { course_id, assignment_id, submission_type } = submitArgs;
            if (!course_id || !assignment_id || !submission_type) {
              throw new Error("Missing required fields: course_id, assignment_id, and submission_type");
            }
            const submission = await this.client.submitAssignment(submitArgs);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(submission, includeRaw) }]
            };
          }
          case "canvas_submit_grade": {
            const gradeArgs = args;
            if (!gradeArgs.course_id || !gradeArgs.assignment_id || !gradeArgs.user_id || gradeArgs.grade === void 0) {
              throw new Error("Missing required fields for grade submission");
            }
            const submission = await this.client.submitGrade(gradeArgs);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(submission, includeRaw) }]
            };
          }
          // Files
          case "canvas_list_files": {
            const { course_id, folder_id } = args;
            if (!course_id) throw new Error("Missing required field: course_id");
            const files = await this.client.listFiles(course_id, folder_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(files, includeRaw) }]
            };
          }
          case "canvas_get_file": {
            const { file_id } = args;
            if (!file_id) throw new Error("Missing required field: file_id");
            const file = await this.client.getFile(file_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(file, includeRaw) }]
            };
          }
          case "canvas_list_folders": {
            const { course_id } = args;
            if (!course_id) throw new Error("Missing required field: course_id");
            const folders = await this.client.listFolders(course_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(folders, includeRaw) }]
            };
          }
          // Pages
          case "canvas_list_pages": {
            const { course_id } = args;
            if (!course_id) throw new Error("Missing required field: course_id");
            const pages = await this.client.listPages(course_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(pages, includeRaw) }]
            };
          }
          case "canvas_get_page": {
            const { course_id, page_url } = args;
            if (!course_id || !page_url) {
              throw new Error("Missing required fields: course_id and page_url");
            }
            const page = await this.client.getPage(course_id, page_url);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(page, includeRaw) }]
            };
          }
          // Calendar
          case "canvas_list_calendar_events": {
            const { start_date, end_date } = args;
            const events = await this.client.listCalendarEvents(start_date, end_date);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(events, includeRaw) }]
            };
          }
          case "canvas_get_upcoming_assignments": {
            const { limit = 10 } = args;
            const assignments = await this.client.getUpcomingAssignments(limit);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(assignments, includeRaw) }]
            };
          }
          // Dashboard
          case "canvas_get_dashboard": {
            const dashboard = await this.client.getDashboard();
            return {
              content: [{ type: "text", text: this.serializeToolOutput(dashboard, includeRaw) }]
            };
          }
          case "canvas_get_dashboard_cards": {
            const cards = await this.client.getDashboardCards();
            return {
              content: [{ type: "text", text: this.serializeToolOutput(cards, includeRaw) }]
            };
          }
          // User management
          case "canvas_get_user_profile": {
            const profile = await this.client.getUserProfile();
            return {
              content: [{ type: "text", text: this.serializeToolOutput(profile, includeRaw) }]
            };
          }
          case "canvas_update_user_profile": {
            const profileData = args;
            const updatedProfile = await this.client.updateUserProfile(profileData);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(updatedProfile, includeRaw) }]
            };
          }
          case "canvas_enroll_user": {
            const enrollArgs = args;
            if (!enrollArgs.course_id || !enrollArgs.user_id) {
              throw new Error("Missing required fields: course_id and user_id");
            }
            const enrollment = await this.client.enrollUser(enrollArgs);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(enrollment, includeRaw) }]
            };
          }
          // Grades
          case "canvas_get_course_grades": {
            const { course_id } = args;
            if (!course_id) throw new Error("Missing required field: course_id");
            const grades = await this.client.getCourseGrades(course_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(grades, includeRaw) }]
            };
          }
          case "canvas_get_user_grades": {
            const grades = await this.client.getUserGrades();
            return {
              content: [{ type: "text", text: this.serializeToolOutput(grades, includeRaw) }]
            };
          }
          // Modules
          case "canvas_list_modules": {
            const { course_id } = args;
            if (!course_id) throw new Error("Missing required field: course_id");
            const modules = await this.client.listModules(course_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(modules, includeRaw) }]
            };
          }
          case "canvas_get_module": {
            const { course_id, module_id } = args;
            if (!course_id || !module_id) {
              throw new Error("Missing required fields: course_id and module_id");
            }
            const module = await this.client.getModule(course_id, module_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(module, includeRaw) }]
            };
          }
          case "canvas_list_module_items": {
            const { course_id, module_id } = args;
            if (!course_id || !module_id) {
              throw new Error("Missing required fields: course_id and module_id");
            }
            const moduleItems = await this.client.listModuleItems(course_id, module_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(moduleItems, includeRaw) }]
            };
          }
          case "canvas_get_module_item": {
            const { course_id, module_id, item_id } = args;
            if (!course_id || !module_id || !item_id) {
              throw new Error("Missing required fields: course_id, module_id, and item_id");
            }
            const moduleItem = await this.client.getModuleItem(course_id, module_id, item_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(moduleItem, includeRaw) }]
            };
          }
          case "canvas_mark_module_item_complete": {
            const { course_id, module_id, item_id } = args;
            if (!course_id || !module_id || !item_id) {
              throw new Error("Missing required fields: course_id, module_id, and item_id");
            }
            await this.client.markModuleItemComplete(course_id, module_id, item_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput({ status: "ok" }, includeRaw) }]
            };
          }
          // Discussions and announcements
          case "canvas_list_discussion_topics": {
            const { course_id } = args;
            if (!course_id) throw new Error("Missing required field: course_id");
            const topics = await this.client.listDiscussionTopics(course_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(topics, includeRaw) }]
            };
          }
          case "canvas_get_discussion_topic": {
            const { course_id, topic_id } = args;
            if (!course_id || !topic_id) {
              throw new Error("Missing required fields: course_id and topic_id");
            }
            const topic = await this.client.getDiscussionTopic(course_id, topic_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(topic, includeRaw) }]
            };
          }
          case "canvas_post_to_discussion": {
            const { course_id, topic_id, message } = args;
            if (!course_id || !topic_id || !message) {
              throw new Error("Missing required fields: course_id, topic_id, and message");
            }
            const post = await this.client.postToDiscussion(course_id, topic_id, message);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(post, includeRaw) }]
            };
          }
          case "canvas_list_announcements": {
            const { course_id } = args;
            if (!course_id) throw new Error("Missing required field: course_id");
            const announcements = await this.client.listAnnouncements(String(course_id));
            return {
              content: [{ type: "text", text: this.serializeToolOutput(announcements, includeRaw) }]
            };
          }
          // Quizzes
          case "canvas_list_quizzes": {
            const { course_id } = args;
            if (!course_id) throw new Error("Missing required field: course_id");
            const quizzes = await this.client.listQuizzes(String(course_id));
            return {
              content: [{ type: "text", text: this.serializeToolOutput(quizzes, includeRaw) }]
            };
          }
          case "canvas_get_quiz": {
            const { course_id, quiz_id } = args;
            if (!course_id || !quiz_id) {
              throw new Error("Missing required fields: course_id and quiz_id");
            }
            const quiz = await this.client.getQuiz(String(course_id), quiz_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(quiz, includeRaw) }]
            };
          }
          case "canvas_create_quiz": {
            const { course_id, ...quizData } = args;
            if (!course_id || !quizData.title) {
              throw new Error("Missing required fields: course_id and title");
            }
            const quiz = await this.client.createQuiz(course_id, quizData);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(quiz, includeRaw) }]
            };
          }
          case "canvas_start_quiz_attempt": {
            const { course_id, quiz_id } = args;
            if (!course_id || !quiz_id) {
              throw new Error("Missing required fields: course_id and quiz_id");
            }
            const quizAttempt = await this.client.startQuizAttempt(course_id, quiz_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(quizAttempt, includeRaw) }]
            };
          }
          // Rubrics
          case "canvas_list_rubrics": {
            const { course_id } = args;
            if (!course_id) throw new Error("Missing required field: course_id");
            const rubrics = await this.client.listRubrics(course_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(rubrics, includeRaw) }]
            };
          }
          case "canvas_get_rubric": {
            const { course_id, rubric_id } = args;
            if (!course_id || !rubric_id) {
              throw new Error("Missing required fields: course_id and rubric_id");
            }
            const rubric = await this.client.getRubric(course_id, rubric_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(rubric, includeRaw) }]
            };
          }
          // Conversations and notifications
          case "canvas_list_conversations": {
            const conversations = await this.client.listConversations();
            return {
              content: [{ type: "text", text: this.serializeToolOutput(conversations, includeRaw) }]
            };
          }
          case "canvas_get_conversation": {
            const { conversation_id } = args;
            if (!conversation_id) throw new Error("Missing required field: conversation_id");
            const conversation = await this.client.getConversation(conversation_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(conversation, includeRaw) }]
            };
          }
          case "canvas_create_conversation": {
            const { recipients, body, subject } = args;
            if (!recipients || recipients.length === 0 || !body) {
              throw new Error("Missing required fields: recipients and body");
            }
            const conversation = await this.client.createConversation(recipients, body, subject);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(conversation, includeRaw) }]
            };
          }
          case "canvas_list_notifications": {
            const notifications = await this.client.listNotifications();
            return {
              content: [{ type: "text", text: this.serializeToolOutput(notifications, includeRaw) }]
            };
          }
          case "canvas_get_syllabus": {
            const { course_id } = args;
            if (!course_id) throw new Error("Missing required field: course_id");
            const syllabus = await this.client.getSyllabus(course_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(syllabus, includeRaw) }]
            };
          }
          // Account Management
          case "canvas_get_account": {
            const { account_id } = args;
            if (!account_id) throw new Error("Missing required field: account_id");
            const account = await this.client.getAccount(account_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(account, includeRaw) }]
            };
          }
          case "canvas_list_account_courses": {
            const accountCoursesArgs = args;
            if (!accountCoursesArgs.account_id) {
              throw new Error("Missing required field: account_id");
            }
            const courses = await this.client.listAccountCourses(accountCoursesArgs);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(courses, includeRaw) }]
            };
          }
          case "canvas_list_account_users": {
            const accountUsersArgs = args;
            if (!accountUsersArgs.account_id) {
              throw new Error("Missing required field: account_id");
            }
            const users = await this.client.listAccountUsers(accountUsersArgs);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(users, includeRaw) }]
            };
          }
          case "canvas_create_user": {
            const createUserArgs = args;
            if (!createUserArgs.account_id || !createUserArgs.user || !createUserArgs.pseudonym) {
              throw new Error("Missing required fields: account_id, user, and pseudonym");
            }
            const user = await this.client.createUser(createUserArgs);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(user, includeRaw) }]
            };
          }
          case "canvas_list_sub_accounts": {
            const { account_id } = args;
            if (!account_id) throw new Error("Missing required field: account_id");
            const subAccounts = await this.client.listSubAccounts(account_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(subAccounts, includeRaw) }]
            };
          }
          case "canvas_get_account_reports": {
            const { account_id } = args;
            if (!account_id) throw new Error("Missing required field: account_id");
            const reports = await this.client.getAccountReports(account_id);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(reports, includeRaw) }]
            };
          }
          case "canvas_create_account_report": {
            const createReportArgs = args;
            if (!createReportArgs.account_id || !createReportArgs.report) {
              throw new Error("Missing required fields: account_id and report");
            }
            const report = await this.client.createAccountReport(createReportArgs);
            return {
              content: [{ type: "text", text: this.serializeToolOutput(report, includeRaw) }]
            };
          }
          default:
            throw new Error(`Unknown tool: ${toolName}`);
        }
      } catch (error) {
        console.error(`Error executing tool ${request.params.name}:`, error);
        const structuredError = this.toStructuredToolError(request.params.name, error);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(structuredError, null, 2)
          }],
          structuredContent: structuredError,
          isError: true
        };
      }
    });
  }
  async parseHttpRequestBody(req) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) {
      return void 0;
    }
    const rawBody = Buffer.concat(chunks).toString("utf8").trim();
    if (!rawBody) {
      return void 0;
    }
    return JSON.parse(rawBody);
  }
  getHttpConfig() {
    return {
      host: this.config.transport?.http?.host ?? "127.0.0.1",
      port: this.config.transport?.http?.port ?? 3e3,
      path: this.config.transport?.http?.path ?? "/mcp",
      statefulSession: this.config.transport?.http?.statefulSession ?? true,
      enableJsonResponse: this.config.transport?.http?.enableJsonResponse ?? true,
      allowedOrigins: this.config.transport?.http?.allowedOrigins ?? []
    };
  }
  isAllowedOrigin(req) {
    const { allowedOrigins } = this.getHttpConfig();
    if (allowedOrigins.length === 0) {
      return true;
    }
    const origin = req.headers.origin;
    if (!origin) {
      return true;
    }
    return allowedOrigins.includes(origin);
  }
  async connectHttpTransport(transport) {
    await this.server.connect(transport);
  }
  async connectStdio(stdin, stdout) {
    const transport = new StdioServerTransport(stdin, stdout);
    await this.server.connect(transport);
    console.error(`${this.config.name} running on stdio`);
  }
  async connectStreamableHttp() {
    if (this.streamableHttpRuntime) {
      return;
    }
    const httpConfig = this.getHttpConfig();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: httpConfig.statefulSession ? () => randomUUID() : void 0,
      enableJsonResponse: httpConfig.enableJsonResponse
    });
    await this.server.connect(transport);
    const requestHandler = async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        if (url.pathname !== httpConfig.path) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Not Found" }));
          return;
        }
        if (!this.isAllowedOrigin(req)) {
          res.statusCode = 403;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Forbidden origin" }));
          return;
        }
        const method = req.method?.toUpperCase() ?? "GET";
        if (!["POST", "GET", "DELETE"].includes(method)) {
          res.statusCode = 405;
          res.setHeader("allow", "POST, GET, DELETE");
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Method Not Allowed" }));
          return;
        }
        let parsedBody;
        if (method === "POST") {
          try {
            parsedBody = await this.parseHttpRequestBody(req);
          } catch {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return;
          }
        }
        await transport.handleRequest(req, res, parsedBody);
      } catch (error) {
        console.error(`Error handling streamable-http request:`, error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32603,
                message: "Internal server error"
              },
              id: null
            })
          );
        }
      }
    };
    const httpServer = createHttpServer((req, res) => {
      void requestHandler(req, res);
    });
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(httpConfig.port, httpConfig.host, () => resolve());
    });
    this.streamableHttpRuntime = { transport, httpServer };
    console.error(
      `${this.config.name} running on streamable-http at http://${httpConfig.host}:${httpConfig.port}${httpConfig.path}`
    );
  }
  getStreamableHttpUrl() {
    if (!this.streamableHttpRuntime) {
      return void 0;
    }
    const httpConfig = this.getHttpConfig();
    const address = this.streamableHttpRuntime.httpServer.address();
    if (!address || typeof address === "string") {
      return void 0;
    }
    const info = address;
    return `http://${httpConfig.host}:${info.port}${httpConfig.path}`;
  }
  async close() {
    if (this.streamableHttpRuntime) {
      await this.streamableHttpRuntime.transport.close();
      await new Promise((resolve, reject) => {
        this.streamableHttpRuntime?.httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.streamableHttpRuntime = void 0;
    }
    await this.server.close();
  }
  async run() {
    const mode = this.config.transport?.mode ?? "stdio";
    if (mode === "streamable-http") {
      await this.connectStreamableHttp();
      return;
    }
    await this.connectStdio();
  }
};
function loadEnvironmentVariables() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const envPaths = [
    ".env",
    "src/.env",
    path.join(__dirname, ".env"),
    path.join(process.cwd(), ".env"),
    path.join(__dirname, "..", ".env")
  ];
  let loaded = false;
  for (const envPath of envPaths) {
    const result = dotenv.config({ path: envPath });
    if (result.parsed) {
      console.error(`Loaded environment from: ${envPath}`);
      loaded = true;
      break;
    }
  }
  if (!loaded) {
    console.error("Warning: No .env file found");
  }
}
function loadConfigFromEnvironment(env = process.env) {
  const token = env.CANVAS_API_TOKEN;
  const domain = env.CANVAS_DOMAIN;
  if (!token || !domain) {
    throw new Error(
      "Missing required environment variables: CANVAS_API_TOKEN and CANVAS_DOMAIN are required."
    );
  }
  const transportMode = env.MCP_TRANSPORT === "streamable-http" ? "streamable-http" : "stdio";
  const allowedOrigins = (env.MCP_HTTP_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  return {
    name: "canvas-mcp-server",
    version: "2.3.0",
    canvas: {
      token,
      domain,
      maxRetries: parseInt(env.CANVAS_MAX_RETRIES || "3", 10),
      retryDelay: parseInt(env.CANVAS_RETRY_DELAY || "1000", 10),
      timeout: parseInt(env.CANVAS_TIMEOUT || "30000", 10)
    },
    logging: {
      level: env.LOG_LEVEL || "info"
    },
    transport: {
      mode: transportMode,
      http: {
        host: env.MCP_HTTP_HOST || "127.0.0.1",
        port: parseInt(env.MCP_HTTP_PORT || "3000", 10),
        path: env.MCP_HTTP_PATH || "/mcp",
        statefulSession: (env.MCP_HTTP_STATEFUL || "true") !== "false",
        enableJsonResponse: (env.MCP_HTTP_JSON_RESPONSE || "true") !== "false",
        allowedOrigins
      }
    }
  };
}
async function main() {
  loadEnvironmentVariables();
  let server;
  try {
    const config2 = loadConfigFromEnvironment(process.env);
    server = new CanvasMCPServer(config2);
    const shutdown = async (signal) => {
      console.error(`Received ${signal}, shutting down...`);
      if (server) {
        await server.close();
      }
      process.exit(0);
    };
    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
    await server.run();
  } catch (error) {
    console.error("Fatal error:", error);
    if (server) {
      await server.close().catch((closeError) => {
        console.error("Error while closing server:", closeError);
      });
    }
    process.exit(1);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}

// api/mcp.js
async function handler(req, res) {
  const secret = process.env.MCP_SECRET;
  if (!secret) {
    res.statusCode = 503;
    return res.end("Server authentication is not configured");
  }
  const supplied = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    res.statusCode = 401;
    return res.end("Unauthorized");
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end("Method Not Allowed");
  }
  let server;
  let transport;
  try {
    const config2 = loadConfigFromEnvironment(process.env);
    server = new CanvasMCPServer(config2);
    transport = new StreamableHTTPServerTransport2({
      sessionIdGenerator: void 0,
      enableJsonResponse: true
    });
    await server.connectHttpTransport(transport);
    let body = req.body;
    if (body === void 0) {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      body = Buffer.concat(chunks).toString("utf8");
    }
    if (typeof body === "string" || Buffer.isBuffer(body)) {
      try {
        body = JSON.parse(body.toString());
      } catch {
        res.statusCode = 400;
        return res.end("Invalid JSON");
      }
    }
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error("MCP request failed:", error instanceof Error ? error.message : "Unknown error");
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal server error");
    }
  } finally {
    await transport?.close();
    await server?.close();
  }
}
export {
  handler as default
};
