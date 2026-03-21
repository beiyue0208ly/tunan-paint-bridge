(function initTunanApiEngine(global) {
  const OPENAI_COMPATIBLE_PROVIDER = 'openai'
  const API_MODEL_DEBUG = false
  const API_CAPTURE_DEBUG = false
  const PROVIDER_MODEL_CATALOGS = {
    'yunwu.ai': [
      {
        id: 'gemini-3-pro-image-preview',
        display_name: 'Gemini 3 Pro Image Preview',
        owned_by: 'google',
        group: 'gemini-3',
        supported_endpoint_types: ['openai', 'gemini'],
        endpoint_type: 'openai',
      },
      {
        id: 'gemini-3.1-flash-image-preview',
        display_name: 'Gemini 3.1 Flash Image Preview',
        owned_by: 'google',
        group: 'gemini-3.1',
        supported_endpoint_types: ['openai', 'gemini'],
        endpoint_type: 'openai',
      },
      {
        id: 'gpt-image-1-all',
        display_name: 'GPT Image 1 All',
        owned_by: 'openai',
        group: 'gpt-image',
        supported_endpoint_types: ['image-generation'],
      },
      {
        id: 'gpt-image-1.5-all',
        display_name: 'GPT Image 1.5 All',
        owned_by: 'openai',
        group: 'gpt-image',
        supported_endpoint_types: ['image-generation'],
      },
      {
        id: 'grok-4-image',
        display_name: 'Grok 4 Image',
        owned_by: 'xai',
        group: 'grok-4',
        supported_endpoint_types: ['image-generation'],
      },
      {
        id: 'fal-ai/nano-banana',
        display_name: 'fal-ai nano banana',
        owned_by: 'fal-ai',
        group: 'fal-ai',
        supported_endpoint_types: ['image-generation'],
      },
      {
        id: 'fal-ai/nano-banana/edit',
        display_name: 'fal-ai nano banana edit',
        owned_by: 'fal-ai',
        group: 'fal-ai',
        supported_endpoint_types: ['image-generation'],
      },
    ],
  }
  const IMAGE_MODEL_HINTS = [
    'image',
    'images',
    'gpt-image',
    'dall-e',
    'qwen-image',
    'flux',
    'banana',
    'seedream',
    'seededit',
    'stable-diffusion',
    'sdxl',
    'kolors',
    'recraft',
    'ideogram',
    'imagen',
    'kontext',
    'grok-image',
    'playground',
    'canvas',
  ]

  class TunanApiEngine {
    constructor() {
      this.currentAbortController = null
    }

    async fetchModels(payload = {}) {
      const config = this.resolveConfig(payload, { requireModel: false })
      const response = await fetch(`${config.baseUrl}/models`, {
        method: 'GET',
        headers: this.buildAuthHeaders(config),
      })
      const data = await this.readJsonResponse(response, {
        operation: 'fetch-models',
        requestPath: '/models',
        baseUrl: config.baseUrl,
      })
      const mergedData = this.mergeProviderCatalog(data, config)
      const models = this.extractModelEntries(mergedData)
      this.logModelFetchSummary(data, mergedData, models, config)

      if (!models.length) {
        throw new Error('没有读取到可用模型，请检查 Base URL 和 API Key 是否正确')
      }

      return {
        provider: config.provider,
        models,
      }
    }

    async generate(payload = {}) {
      const config = this.resolveConfig(payload, { requireModel: true })
      await this.persistCaptureDebugArtifacts(payload, config)
      const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null
      this.currentAbortController = abortController
      let data = null
      try {
        if (config.endpointType === 'gemini') {
          data = await this.generateWithGemini(payload, config, abortController?.signal)
        } else if (config.endpointType === 'openai') {
          data = await this.generateWithOpenAiChatCompletions(payload, config, abortController?.signal)
        } else {
          data = await this.generateWithOpenAiImages(payload, config, abortController?.signal)
        }
      } catch (error) {
        if (error?.name === 'AbortError') {
          return {
            accepted: false,
            stopped: true,
          }
        }
        throw error
      } finally {
        if (this.currentAbortController === abortController) {
          this.currentAbortController = null
        }
      }
      const image = await this.extractImageDataUrl(data)

      if (!image) {
        throw new Error(this.buildMissingImageResultError(data, config))
      }

      const imageDimensions = this.extractImageDimensionsFromDataUrl(image)
      const placement = payload.capture?.placement || null
      const visibleBounds =
        imageDimensions.width > 0 && imageDimensions.height > 0
          ? {
              left: 0,
              top: 0,
              right: imageDimensions.width,
              bottom: imageDimensions.height,
              width: imageDimensions.width,
              height: imageDimensions.height,
            }
          : null

      return {
        accepted: true,
        image,
        meta: {
          source: 'api',
          provider: config.provider,
          model: config.model,
          endpointType: config.endpointType,
          prompt: payload.prompt || '',
          receivedAt: Date.now(),
          placement,
          imageWidth: imageDimensions.width,
          imageHeight: imageDimensions.height,
          visibleBounds,
          documentName: payload.capture?.meta?.document_name || '',
          captureSource: payload.capture?.meta?.source || '',
          selectionSendMode: payload.capture?.meta?.selection_send_mode || '',
        },
      }
    }

    async stopTask() {
      if (!this.currentAbortController) {
        return { stopped: false }
      }

      try {
        this.currentAbortController.abort()
      } finally {
        this.currentAbortController = null
      }

      return { stopped: true }
    }

    async persistCaptureDebugArtifacts(payload = {}, config = {}) {
      if (!API_CAPTURE_DEBUG || !payload?.sendCanvas || !payload?.capture?.image?.data) {
        return null
      }

      try {
        const uxp = require('uxp')
        const fs = uxp.storage.localFileSystem
        const tempFolder = await fs.getTemporaryFolder()
        const stamp = Date.now()
        const captureImage = payload.capture?.image || {}
        const selectionMask = payload.capture?.selectionMask || null
        const captureImageDataUrl = await this.resolveCaptureAssetDataUrl(captureImage)
        const selectionMaskDataUrl = await this.resolveCaptureAssetDataUrl(selectionMask)

        if (!captureImageDataUrl) {
          console.log('[ApiCapture:error]', 'capture image missing data url')
          return null
        }

        const captureFile = await tempFolder.createFile(
          `api_capture_${stamp}.${this.resolveDataUrlExtension(captureImageDataUrl, captureImage.outputFormat || captureImage.format || 'png')}`,
          { overwrite: true },
        )
        await captureFile.write(this.dataUrlToArrayBuffer(captureImageDataUrl))

        let selectionMaskFile = null
        if (selectionMaskDataUrl) {
          selectionMaskFile = await tempFolder.createFile(
            `api_capture_mask_${stamp}.${this.resolveDataUrlExtension(selectionMaskDataUrl, selectionMask.outputFormat || selectionMask.format || 'png')}`,
            { overwrite: true },
          )
          await selectionMaskFile.write(this.dataUrlToArrayBuffer(selectionMaskDataUrl))
        }

        const metaFile = await tempFolder.createFile(`api_capture_${stamp}.json`, { overwrite: true })
        await metaFile.write(
          JSON.stringify(
            {
              model: config.model,
              endpointType: config.endpointType,
              promptPreview: String(payload.prompt || '').slice(0, 240),
              sendCanvas: Boolean(payload.sendCanvas),
              referenceImageCount: Array.isArray(payload.referenceImages) ? payload.referenceImages.length : 0,
              captureImage: {
                name: captureImage.name || '',
                format: captureImage.format || '',
                width: Number(captureImage.width || 0),
                height: Number(captureImage.height || 0),
              },
              captureMeta: payload.capture?.meta || null,
              capturePlacement: payload.capture?.placement || null,
              selectionMask: selectionMask
                ? {
                    name: selectionMask.name || '',
                    format: selectionMask.format || '',
                    width: Number(selectionMask.width || 0),
                    height: Number(selectionMask.height || 0),
                  }
                : null,
            },
            null,
            2,
          ),
        )

        console.log('[ApiCapture]', {
          imageFile: captureFile.nativePath || captureFile.name,
          maskFile: selectionMaskFile?.nativePath || selectionMaskFile?.name || '',
          metaFile: metaFile.nativePath || metaFile.name,
          model: config.model,
          endpointType: config.endpointType,
          selectionSendMode: payload.capture?.meta?.selection_send_mode || '',
          sendBounds: payload.capture?.meta?.send_bounds || null,
          originalBounds: payload.capture?.meta?.original_bounds || null,
        })

        return {
          imageFile: captureFile.nativePath || captureFile.name,
          maskFile: selectionMaskFile?.nativePath || selectionMaskFile?.name || '',
          metaFile: metaFile.nativePath || metaFile.name,
        }
      } catch (error) {
        console.log('[ApiCapture:error]', error?.message || String(error))
        return null
      }
    }

    resolveConfig(payload = {}, options = {}) {
      const requireModel = options.requireModel !== false
      const settings = payload.settings || {}
      const profile = this.resolveActiveProfile(settings)
      const provider = profile.provider || OPENAI_COMPATIBLE_PROVIDER

      if (provider !== OPENAI_COMPATIBLE_PROVIDER) {
        throw new Error('当前仅支持 OpenAI 兼容图片接口')
      }

      const apiKey = String(profile.apiKey || '').trim()
      if (!apiKey) {
        throw new Error('请先填写 API Key')
      }

      const baseUrl = this.normalizeBaseUrl(String(profile.baseUrl || '').trim())
      const model = String(profile.activeModel || profile.model || '').trim()
      if (requireModel && !model) {
        throw new Error('请先选择图片模型')
      }

      const activeModelEntry = this.resolveActiveModelEntry(profile, model)
      const supportedEndpointTypes = this.resolveSupportedEndpointTypes(activeModelEntry, model)
      const explicitEndpointType = this.normalizeEndpointType(
        activeModelEntry?.endpointType ||
          activeModelEntry?.endpoint_type ||
          '',
      )
      const endpointType =
        explicitEndpointType ||
        this.resolvePreferredEndpointType(supportedEndpointTypes, model) ||
        this.resolvePreferredEndpointType([], model)

      return {
        provider,
        apiKey,
        baseUrl,
        model,
        activeModelEntry,
        supportedEndpointTypes,
        endpointType,
      }
    }

    resolveActiveProfile(settings = {}) {
      const profiles = Array.isArray(settings.apiProfiles) ? settings.apiProfiles : []
      const activeId = String(settings.activeApiProfileId || '').trim()
      const activeProfile =
        profiles.find((profile) => String(profile?.id || '') === activeId) ||
        profiles[0] ||
        null

      if (activeProfile) {
        return {
          provider: activeProfile.providerType || activeProfile.apiProvider || OPENAI_COMPATIBLE_PROVIDER,
          apiKey: activeProfile.apiKey,
          baseUrl: activeProfile.baseUrl || activeProfile.apiBaseUrl,
          savedModels: Array.isArray(activeProfile.savedModels) ? activeProfile.savedModels : [],
          activeModel: activeProfile.activeModel || activeProfile.model || activeProfile.apiModel,
        }
      }

      return {
        provider: settings.apiProvider || OPENAI_COMPATIBLE_PROVIDER,
        apiKey: settings.apiKey,
        baseUrl: settings.apiBaseUrl,
        savedModels: [],
        activeModel: settings.apiModel,
      }
    }

    normalizeBaseUrl(rawBaseUrl = '') {
      if (!rawBaseUrl) {
        throw new Error('请先填写 Base URL')
      }

      let url = null
      try {
        url = new URL(rawBaseUrl)
      } catch {
        throw new Error('Base URL 格式不正确')
      }

      const pathname = (url.pathname || '/').replace(/\/+$/, '')
      if (!pathname || pathname === '') {
        url.pathname = '/v1'
      } else if (!/\/v\d+$/i.test(pathname)) {
        url.pathname = `${pathname}/v1`
      } else {
        url.pathname = pathname
      }

      url.search = ''
      url.hash = ''
      return url.toString().replace(/\/$/, '')
    }

    buildAuthHeaders(config) {
      return {
        Authorization: `Bearer ${config.apiKey}`,
      }
    }

    async generateWithOpenAiImages(payload = {}, config = {}, signal = null) {
      const body = await this.buildGenerationBody(payload, config)
      const response = await fetch(`${config.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          ...this.buildAuthHeaders(config),
          'Content-Type': 'application/json',
        },
        signal,
        body: JSON.stringify(body),
      })
      return this.readJsonResponse(response, {
        operation: 'generate',
        requestPath: '/images/generations',
        baseUrl: config.baseUrl,
        endpointType: config.endpointType,
        model: config.model,
      })
    }

    async generateWithOpenAiChatCompletions(payload = {}, config = {}, signal = null) {
      const body = await this.buildOpenAiChatGenerationBody(payload, config)
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          ...this.buildAuthHeaders(config),
          'Content-Type': 'application/json',
        },
        signal,
        body: JSON.stringify(body),
      })

      return this.readJsonResponse(response, {
        operation: 'generate',
        requestPath: '/chat/completions',
        baseUrl: config.baseUrl,
        endpointType: config.endpointType,
        model: config.model,
      })
    }

    async generateWithGemini(payload = {}, config = {}, signal = null) {
      const response = await fetch(
        `${this.normalizeGeminiBaseUrl(config.baseUrl)}/models/${encodeURIComponent(config.model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            ...this.buildAuthHeaders(config),
            'Content-Type': 'application/json',
          },
          signal,
          body: JSON.stringify(await this.buildGeminiGenerationBody(payload, config)),
        },
      )

      return this.readJsonResponse(response, {
        operation: 'generate',
        requestPath: `/models/${encodeURIComponent(config.model)}:generateContent`,
        baseUrl: this.normalizeGeminiBaseUrl(config.baseUrl),
        endpointType: config.endpointType,
        model: config.model,
      })
    }

    async buildGenerationBody(payload = {}, config = {}) {
      const imageRoles = await this.collectImageRoles(payload)
      const enrichedPrompt = this.buildImageRolePrompt(payload, imageRoles)
      const body = {
        model: config.model,
        prompt: enrichedPrompt,
        n: 1,
        response_format: 'b64_json',
      }

      if (imageRoles.primaryImage) {
        body.image = imageRoles.primaryImage
        if (imageRoles.referenceImages.length > 0) {
          body.images = [imageRoles.primaryImage, ...imageRoles.referenceImages]
          body.reference_images = imageRoles.referenceImages
        }
      } else {
        const requestedSize = this.resolveRequestedSize(payload)
        if (requestedSize) {
          body.size = requestedSize
        }
      }

      return body
    }

    async buildGeminiGenerationBody(payload = {}, config = {}) {
      const imageRoles = await this.collectImageRoles(payload)
      const prompt = this.buildImageRolePrompt(payload, imageRoles)
      const parts = []

      if (prompt) {
        parts.push({ text: prompt })
      }

      if (imageRoles.primaryImage) {
        parts.push({ text: imageRoles.captureImage ? '主图（当前画布 / 选区）' : '主参考图' })
        const inlineData = this.resolveGeminiInlineData(imageRoles.primaryImage)
        if (inlineData) {
          parts.push({ inlineData })
        }
      }

      imageRoles.referenceImages.forEach((image, index) => {
        parts.push({ text: `参考图 ${index + 1}` })
        const inlineData = this.resolveGeminiInlineData(image)
        if (inlineData) {
          parts.push({ inlineData })
        }
      })

      if (!parts.length) {
        parts.push({ text: '请生成一张图像。' })
      }

      return {
        contents: [
          {
            role: 'user',
            parts,
          },
        ],
        generationConfig: {
          responseModalities: ['IMAGE'],
        },
      }
    }

    async buildOpenAiChatGenerationBody(payload = {}, config = {}) {
      const imageRoles = await this.collectImageRoles(payload)
      const prompt = this.buildImageRolePrompt(payload, imageRoles)
      const content = []

      if (prompt) {
        content.push({
          type: 'text',
          text: prompt,
        })
      }

      if (imageRoles.primaryImage) {
        content.push({
          type: 'text',
          text: imageRoles.captureImage ? '主图（当前画布 / 选区）' : '主参考图',
        })
        content.push({
          type: 'image_url',
          image_url: {
            url: imageRoles.primaryImage,
          },
        })
      }

      imageRoles.referenceImages.forEach((image, index) => {
        content.push({
          type: 'text',
          text: `参考图 ${index + 1}`,
        })
        content.push({
          type: 'image_url',
          image_url: {
            url: image,
          },
        })
      })

      if (!content.length) {
        content.push({
          type: 'text',
          text: '请生成一张图像。',
        })
      }

      return {
        model: config.model,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content,
          },
        ],
      }
    }

    async collectImageRoles(payload = {}) {
      const captureImage = payload.sendCanvas
        ? await this.resolveCaptureAssetDataUrl(payload.capture?.image)
        : null

      const references = []
      if (Array.isArray(payload.referenceImages)) {
        for (const image of payload.referenceImages) {
          if (image) {
            references.push(image)
          }
        }
      }

      const normalizedReferences = references.filter(Boolean)
      const primaryImage = captureImage || normalizedReferences[0] || null
      const referenceImages = captureImage
        ? normalizedReferences
        : normalizedReferences.slice(1)

      return {
        captureImage,
        primaryImage,
        referenceImages,
      }
    }

    buildImageRolePrompt(payload = {}, imageRoles = {}) {
      const userPrompt = String(payload.prompt || '').trim()
      const hasCaptureImage = Boolean(imageRoles.captureImage)
      const referenceCount = Array.isArray(imageRoles.referenceImages) ? imageRoles.referenceImages.length : 0
      const hasPrimaryImage = Boolean(imageRoles.primaryImage)

      const instructions = []

      if (hasCaptureImage) {
        instructions.push('第 1 张图是主图，也就是当前 Photoshop 画布 / 选区。请以主图的构图、主体位置和范围为准。')
      } else if (hasPrimaryImage) {
        instructions.push('第 1 张图是主参考图，没有当前画布主图时，请优先参考这张图。')
      }

      if (referenceCount > 0) {
        instructions.push(`后面还有 ${referenceCount} 张参考图，只用于参考风格、材质、配色、氛围或局部设计，不要直接拼贴参考图内容。`)
      }

      if (!userPrompt && hasPrimaryImage) {
        instructions.push('如果没有额外文字要求，请基于主图和参考图关系，自然完成生成。')
      }

      const instructionText = instructions.join(' ')
      if (instructionText && userPrompt) {
        return `${instructionText}\n\n用户要求：${userPrompt}`
      }
      return instructionText || userPrompt || '请生成一张图像。'
    }

    resolveRequestedSize(payload = {}) {
      const settings = payload.settings || {}
      if (settings.sizeLimit === 'original') {
        return '1024x1024'
      }

      const sizeValue =
        settings.sizeLimit === 'custom'
          ? Number(settings.customSizeValue || 0)
          : Number(settings.sizeLimit || 0)

      if (!Number.isFinite(sizeValue) || sizeValue <= 0) {
        return '1024x1024'
      }

      const edge = Math.max(256, Math.min(2048, Math.round(sizeValue)))
      return `${edge}x${edge}`
    }

    normalizeGeminiBaseUrl(baseUrl = '') {
      const url = new URL(baseUrl)
      const pathname = (url.pathname || '').replace(/\/+$/, '')
      if (/\/v\d+$/i.test(pathname)) {
        url.pathname = pathname.replace(/\/v\d+$/i, '/v1beta')
      } else {
        url.pathname = pathname ? `${pathname}/v1beta` : '/v1beta'
      }
      return url.toString().replace(/\/$/, '')
    }

    async readJsonResponse(response, context = {}) {
      const rawText = await response.text()
      let data = null
      try {
        data = rawText ? JSON.parse(rawText) : {}
      } catch {
        data = {}
      }

      if (!response.ok) {
        const message = this.resolveErrorMessage(data, response.status, rawText, context) || 'API 请求失败'
        throw new Error(message)
      }

      return data
    }

    resolveErrorMessage(data = {}, status = 0, rawText = '', context = {}) {
      const detail = this.extractErrorDetail(data, rawText)
      const contextSuffix = this.describeErrorContext(context)

      if (status === 401 || status === 403) {
        return `API Key 无效，或当前账号没有访问权限${detail ? `：${detail}` : ''}`
      }
      if (status === 404) {
        return `接口地址无效，或当前模型不支持这个接口${contextSuffix}${detail ? `：${detail}` : ''}`
      }
      if (status === 429) {
        return `请求过于频繁，或当前账号额度不足${detail ? `：${detail}` : ''}`
      }
      if (status >= 500) {
        return `API 接口返回 ${status}${contextSuffix}${detail ? `：${detail}` : ''}`
      }

      return detail
        ? `API 请求失败${status ? ` (${status})` : ''}${contextSuffix}：${detail}`
        : status
          ? `API 请求失败 (${status})${contextSuffix}`
          : 'API 请求失败'
    }

    extractErrorDetail(data = {}, rawText = '') {
      const directMessage =
        data?.error?.message ||
        data?.message ||
        data?.msg ||
        data?.error_description ||
        data?.detail ||
        ''

      const normalizedDirectMessage = String(directMessage || '').trim()
      if (normalizedDirectMessage) {
        return normalizedDirectMessage
      }

      const normalizedRawText = String(rawText || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      if (!normalizedRawText) {
        return ''
      }

      return normalizedRawText.length > 180
        ? `${normalizedRawText.slice(0, 180)}...`
        : normalizedRawText
    }

    describeErrorContext(context = {}) {
      const parts = []
      const endpointType = String(context?.endpointType || '').trim()
      const model = String(context?.model || '').trim()
      const requestPath = String(context?.requestPath || '').trim()

      if (endpointType === 'gemini') {
        parts.push('Gemini原生接口')
      } else if (endpointType === 'openai') {
        parts.push('Chat兼容接口')
      } else if (endpointType === 'image-generation') {
        parts.push('Images接口')
      }

      if (model) {
        parts.push(`模型 ${model}`)
      }

      if (requestPath) {
        parts.push(requestPath)
      }

      return parts.length ? `（${parts.join(' / ')}）` : ''
    }

    extractModelEntries(data = {}) {
      const rawModels = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
          ? data.models
          : []

      const entries = []
      const seen = new Set()

      for (const item of rawModels) {
        const id = String(typeof item === 'string' ? item : item?.id || item?.model || '').trim()
        if (!id || seen.has(id)) continue
        seen.add(id)
        const supportedEndpointTypes = this.resolveSupportedEndpointTypes(item, id)
        const preferredEndpointType = this.resolvePreferredEndpointType(supportedEndpointTypes, id)
        const score = this.scoreImageModel(id)
        const owner = this.resolveModelOwner(item, id)
        const group = this.resolveModelGroup(item, id, owner)
        const label = this.resolveModelLabel(item, id)
        entries.push({
          id,
          label,
          owner,
          group,
          score,
          isImageLikely:
            score > 0 ||
            supportedEndpointTypes.includes('image-generation') ||
            supportedEndpointTypes.includes('gemini'),
          supportedEndpointTypes,
          endpointType: preferredEndpointType,
        })
      }

      return entries
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score
          if ((left.group || '') !== (right.group || '')) {
            return String(left.group || '').localeCompare(String(right.group || ''))
          }
          return left.id.localeCompare(right.id)
        })
    }

    resolveModelOwner(item, modelId = '') {
      const explicitOwner =
        (typeof item === 'object' && item
          ? item.owned_by || item.ownedBy || item.provider || item.organization || item.vendor || ''
          : '') || ''
      const normalizedExplicitOwner = String(explicitOwner || '').trim()
      if (normalizedExplicitOwner) {
        return normalizedExplicitOwner
      }

      const normalizedId = String(modelId || '').trim()
      if (normalizedId.includes('/')) {
        return normalizedId.split('/')[0]
      }

      const lowerId = normalizedId.toLowerCase()
      if (lowerId.includes('gpt-image') || lowerId.includes('dall-e')) return 'openai'
      if (lowerId.includes('qwen')) return 'qwen'
      if (lowerId.includes('flux')) return 'black-forest-labs'
      if (lowerId.includes('recraft')) return 'recraft'
      if (lowerId.includes('sdxl') || lowerId.includes('stable-diffusion')) return 'stability'
      if (lowerId.includes('imagen')) return 'google'
      if (lowerId.includes('ideogram')) return 'ideogram'

      return ''
    }

    resolveModelGroup(item, modelId = '', owner = '') {
      const explicitGroup =
        (typeof item === 'object' && item
          ? item.group || item.groupLabel || item.family || item.category || item.series || ''
          : '') || ''
      const normalizedExplicitGroup = String(explicitGroup || '').trim()
      if (normalizedExplicitGroup) {
        return normalizedExplicitGroup
      }

      return owner || '未分类'
    }

    resolveModelLabel(item, modelId = '') {
      const explicitLabel =
        (typeof item === 'object' && item ? item.label || item.name || item.display_name || '' : '') || ''
      return String(explicitLabel || modelId || '').trim()
    }

    resolveSupportedEndpointTypes(item, modelId = '') {
      const rawTypes =
        (typeof item === 'object' && item
          ? item.supported_endpoint_types || item.supportedEndpointTypes || item.endpoint_types || item.endpointTypes
          : []) || []
      const normalizedTypes = [...new Set((Array.isArray(rawTypes) ? rawTypes : [rawTypes])
        .map((type) => this.normalizeEndpointType(type))
        .filter(Boolean))]

      if (normalizedTypes.length > 0) {
        return normalizedTypes
      }

      const inferredType = this.resolvePreferredEndpointType([], modelId)
      return inferredType ? [inferredType] : []
    }

    resolvePreferredEndpointType(supportedEndpointTypes = [], modelId = '') {
      const normalizedTypes = [...new Set((supportedEndpointTypes || []).map((type) => this.normalizeEndpointType(type)).filter(Boolean))]
      if (normalizedTypes.includes('image-generation')) {
        return 'image-generation'
      }
      if (normalizedTypes.length > 0) {
        return normalizedTypes[0]
      }

      const normalizedId = String(modelId || '').trim().toLowerCase()
      if (normalizedId.includes('gemini') && normalizedId.includes('image')) {
        return 'gemini'
      }
      return 'image-generation'
    }

    normalizeEndpointType(rawType) {
      const normalized = String(rawType || '').trim().toLowerCase()
      if (!normalized) return ''

      if (normalized.includes('/images/generations')) {
        return 'image-generation'
      }

      if (normalized.includes(':generatecontent') || normalized.includes('/v1beta/models/')) {
        return 'gemini'
      }

      if (normalized.includes('/chat/completions')) {
        return 'openai'
      }

      switch (normalized) {
        case 'image-generation':
        case 'image_generation':
          return 'image-generation'
        case 'gemini':
          return 'gemini'
        case 'openai':
        case 'chat':
        case 'chat-completions':
        case 'chat_completions':
          return 'openai'
        default:
          return ''
      }
    }

    scoreImageModel(modelId = '') {
      const normalized = String(modelId || '').toLowerCase()
      let score = 0
      for (const hint of IMAGE_MODEL_HINTS) {
        if (normalized.includes(hint)) {
          score += 10
        }
      }
      if (normalized.includes('rerank')) {
        score -= 20
      }
      return score
    }

    logModelFetchSummary(rawData = {}, mergedData = {}, models = [], config = {}) {
      if (!API_MODEL_DEBUG) return

      try {
        const rawModels = Array.isArray(rawData?.data)
          ? rawData.data
          : Array.isArray(rawData?.models)
            ? rawData.models
            : []
        const mergedModels = Array.isArray(mergedData?.data)
          ? mergedData.data
          : Array.isArray(mergedData?.models)
            ? mergedData.models
            : []
        const rawGemini = rawModels
          .map((item) => String(typeof item === 'string' ? item : item?.id || item?.model || '').trim())
          .filter((item) => item.toLowerCase().includes('gemini'))
        const mergedGemini = mergedModels
          .map((item) => String(typeof item === 'string' ? item : item?.id || item?.model || '').trim())
          .filter((item) => item.toLowerCase().includes('gemini'))
        const normalizedGemini = models
          .map((item) => String(item?.id || '').trim())
          .filter((item) => item.toLowerCase().includes('gemini'))

        console.log('[ApiModels] fetch:summary', {
          baseUrl: config.baseUrl,
          rawCount: rawModels.length,
          mergedCount: mergedModels.length,
          normalizedCount: models.length,
          rawGeminiCount: rawGemini.length,
          mergedGeminiCount: mergedGemini.length,
          normalizedGeminiCount: normalizedGemini.length,
          rawGeminiPreview: rawGemini.slice(0, 12),
          mergedGeminiPreview: mergedGemini.slice(0, 12),
          normalizedGeminiPreview: normalizedGemini.slice(0, 12),
        })
      } catch (error) {
        console.log('[ApiModels] fetch:summary:error', error?.message || String(error))
      }
    }

    mergeProviderCatalog(data = {}, config = {}) {
      const rawModels = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
          ? data.models
          : []
      const catalogModels = this.getProviderCatalogModels(config)
      if (!catalogModels.length) return data

      const merged = [...rawModels]
      const seen = new Set(
        rawModels.map((item) => String(typeof item === 'string' ? item : item?.id || item?.model || '').trim()).filter(Boolean),
      )

      for (const model of catalogModels) {
        const id = String(model?.id || '').trim()
        if (!id || seen.has(id)) continue
        seen.add(id)
        merged.push(model)
      }

      if (Array.isArray(data?.data)) {
        return { ...data, data: merged }
      }
      if (Array.isArray(data?.models)) {
        return { ...data, models: merged }
      }
      return { ...data, data: merged }
    }

    getProviderCatalogModels(config = {}) {
      try {
        const normalizedBaseUrl = String(config?.baseUrl || '').trim()
        if (!normalizedBaseUrl) return []
        const hostname = new URL(normalizedBaseUrl).hostname.toLowerCase()
        return PROVIDER_MODEL_CATALOGS[hostname] || []
      } catch {
        return []
      }
    }

    async extractImageDataUrl(data = {}) {
      const openAiChatImage = await this.extractOpenAiChatImageDataUrl(data)
      if (openAiChatImage) {
        return openAiChatImage
      }

      const geminiInlineData = this.extractGeminiInlineDataUrl(data)
      if (geminiInlineData) {
        return geminiInlineData
      }

      const items = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.images)
          ? data.images
          : []

      for (const item of items) {
        const dataUrl = await this.extractSingleImageDataUrl(item)
        if (dataUrl) return dataUrl
      }

      const single = await this.extractSingleImageDataUrl(data)
      return single || ''
    }

    async extractOpenAiChatImageDataUrl(data = {}) {
      const choices = Array.isArray(data?.choices) ? data.choices : []
      for (const choice of choices) {
        const message = choice?.message || choice?.delta || {}

        const imageCollectionDataUrl = await this.extractImageCollectionDataUrl(message?.images)
        if (imageCollectionDataUrl) {
          return imageCollectionDataUrl
        }

        const content = Array.isArray(message?.content) ? message.content : []
        const contentImageDataUrl = await this.extractImageCollectionDataUrl(content)
        if (contentImageDataUrl) {
          return contentImageDataUrl
        }

        const nestedImageDataUrl = await this.extractNestedImageDataUrl(message)
        if (nestedImageDataUrl) {
          return nestedImageDataUrl
        }
      }

      return ''
    }

    async extractImageCollectionDataUrl(items = []) {
      const collection = Array.isArray(items) ? items : []
      for (const item of collection) {
        const dataUrl = await this.extractSingleImageDataUrl(item)
        if (dataUrl) {
          return dataUrl
        }
      }
      return ''
    }

    extractGeminiInlineDataUrl(data = {}) {
      const candidates = Array.isArray(data?.candidates) ? data.candidates : []
      for (const candidate of candidates) {
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
        for (const part of parts) {
          const inlineData = part?.inlineData || part?.inline_data
          const base64 = inlineData?.data
          if (base64) {
            return this.ensureDataUrl(String(base64), inlineData?.mimeType || inlineData?.mime_type || 'image/png')
          }
        }
      }
      return ''
    }

    resolveGeminiInlineData(rawImage = '') {
      const normalized = String(rawImage || '').trim()
      if (!normalized) return null

      const dataUrlMatch = normalized.match(/^data:([^;]+);base64,(.+)$/i)
      if (dataUrlMatch) {
        return {
          mimeType: dataUrlMatch[1] || 'image/png',
          data: dataUrlMatch[2] || '',
        }
      }

      return {
        mimeType: 'image/png',
        data: normalized,
      }
    }

    resolveActiveModelEntry(profile = {}, modelId = '') {
      const savedModels = Array.isArray(profile?.savedModels) ? profile.savedModels : []
      return (
        savedModels.find((item) => {
          if (typeof item === 'string') {
            return String(item || '').trim() === modelId
          }
          return String(item?.id || item?.model || item?.value || '').trim() === modelId
        }) || null
      )
    }

    async extractSingleImageDataUrl(item = {}) {
      if (!item) return ''

      if (typeof item === 'string') {
        return this.extractImageFromString(item)
      }

      const b64 =
        item?.b64_json ||
        item?.base64 ||
        item?.image_base64 ||
        item?.image_b64 ||
        item?.data

      if (b64) {
        return this.ensureDataUrl(String(b64), item?.mime_type || item?.mimeType || 'image/png')
      }

      const imageUrl =
        item?.url ||
        item?.image_url?.url ||
        item?.image_url ||
        item?.imageUrl?.url ||
        item?.imageUrl

      if (typeof imageUrl === 'string' && imageUrl) {
        return this.fetchImageAsDataUrl(imageUrl)
      }

      return ''
    }

    async extractNestedImageDataUrl(value, depth = 0) {
      if (!value || depth > 6) return ''

      const direct = await this.extractSingleImageDataUrl(value)
      if (direct) {
        return direct
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          const nested = await this.extractNestedImageDataUrl(item, depth + 1)
          if (nested) {
            return nested
          }
        }
        return ''
      }

      if (typeof value === 'object') {
        for (const key of Object.keys(value)) {
          const nested = await this.extractNestedImageDataUrl(value[key], depth + 1)
          if (nested) {
            return nested
          }
        }
      }

      return ''
    }

    extractImageFromString(value = '') {
      const normalized = String(value || '').trim()
      if (!normalized) return ''

      if (normalized.startsWith('data:image/')) {
        return normalized
      }

      const dataUrlMatch = normalized.match(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/i)
      if (dataUrlMatch?.[0]) {
        return dataUrlMatch[0]
      }

      const markdownImageMatch = normalized.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)/i)
      if (markdownImageMatch?.[1]) {
        return markdownImageMatch[1]
      }

      const bareUrlMatch = normalized.match(/https?:\/\/[^\s"'<>]+/i)
      if (bareUrlMatch?.[0] && this.looksLikeImageUrl(bareUrlMatch[0])) {
        return bareUrlMatch[0]
      }

      return ''
    }

    looksLikeImageUrl(url = '') {
      const normalized = String(url || '').toLowerCase()
      if (!normalized.startsWith('http')) return false
      return (
        /\.(png|jpg|jpeg|webp|gif|bmp)(\?|$)/i.test(normalized) ||
        normalized.includes('image') ||
        normalized.includes('img') ||
        normalized.includes('b64')
      )
    }

    buildMissingImageResultError(data = {}, config = {}) {
      const contextSuffix = this.describeErrorContext({
        endpointType: config?.endpointType,
        model: config?.model,
      })
      const summary = this.summarizeSuccessfulResponse(data)
      return summary
        ? `API 返回成功，但没有拿到图片结果${contextSuffix}。响应摘要：${summary}`
        : `API 返回成功，但没有拿到图片结果${contextSuffix}`
    }

    summarizeSuccessfulResponse(data = {}) {
      try {
        const choices = Array.isArray(data?.choices) ? data.choices : []
        if (choices.length > 0) {
          const message = choices[0]?.message || choices[0]?.delta || {}
          const content = message?.content
          if (typeof content === 'string') {
            const normalized = content.replace(/\s+/g, ' ').trim()
            return normalized ? `message.content="${normalized.slice(0, 160)}"` : 'message.content=<empty>'
          }
          if (Array.isArray(content)) {
            const types = content.map((item) => item?.type || typeof item).filter(Boolean)
            return `message.content types=[${types.join(', ')}]`
          }
          if (Array.isArray(message?.images)) {
            return `message.images count=${message.images.length}`
          }
          return `message keys=[${Object.keys(message || {}).slice(0, 8).join(', ')}]`
        }

        const topLevelKeys = Object.keys(data || {}).slice(0, 10)
        return topLevelKeys.length ? `top-level keys=[${topLevelKeys.join(', ')}]` : ''
      } catch {
        return ''
      }
    }

    ensureDataUrl(rawValue, mimeType = 'image/png') {
      if (String(rawValue).startsWith('data:')) {
        return rawValue
      }
      return `data:${mimeType};base64,${rawValue}`
    }

    async resolveCaptureAssetDataUrl(asset = null) {
      if (!asset) return ''
      if (typeof asset?.data === 'string' && asset.data.startsWith('data:image/')) {
        return asset.data
      }
      if (asset?.rawPixels) {
        return this.rawCapturePayloadToDataUrl(asset)
      }
      return ''
    }

    async rawCapturePayloadToDataUrl(asset = {}) {
      const rawPixels = asset.rawPixels instanceof Uint8Array
        ? asset.rawPixels
        : asset.rawPixels
          ? new Uint8Array(asset.rawPixels)
          : null
      if (!rawPixels?.length) {
        return ''
      }

      const sourceWidth = Math.max(1, Math.round(asset.sourceWidth || asset.canvasWidth || asset.width || 1))
      const sourceHeight = Math.max(1, Math.round(asset.sourceHeight || asset.canvasHeight || asset.height || 1))
      const canvasWidth = Math.max(1, Math.round(asset.canvasWidth || sourceWidth))
      const canvasHeight = Math.max(1, Math.round(asset.canvasHeight || sourceHeight))
      const outputWidth = Math.max(1, Math.round(asset.width || canvasWidth))
      const outputHeight = Math.max(1, Math.round(asset.height || canvasHeight))
      const offsetX = Math.round(asset.offsetX || 0)
      const offsetY = Math.round(asset.offsetY || 0)
      const components = Math.max(1, Math.round(asset.components || 4))
      const rgba = new Uint8Array(canvasWidth * canvasHeight * 4)

      for (let y = 0; y < sourceHeight; y += 1) {
        for (let x = 0; x < sourceWidth; x += 1) {
          const destX = x + offsetX
          const destY = y + offsetY
          if (destX < 0 || destX >= canvasWidth || destY < 0 || destY >= canvasHeight) {
            continue
          }

          const srcIndex = (y * sourceWidth + x) * components
          const dstIndex = (destY * canvasWidth + destX) * 4

          if (components === 1) {
            const value = rawPixels[srcIndex]
            rgba[dstIndex] = value
            rgba[dstIndex + 1] = value
            rgba[dstIndex + 2] = value
            rgba[dstIndex + 3] = 255
          } else if (components === 2) {
            const value = rawPixels[srcIndex]
            rgba[dstIndex] = value
            rgba[dstIndex + 1] = value
            rgba[dstIndex + 2] = value
            rgba[dstIndex + 3] = rawPixels[srcIndex + 1]
          } else {
            rgba[dstIndex] = rawPixels[srcIndex]
            rgba[dstIndex + 1] = rawPixels[srcIndex + 1]
            rgba[dstIndex + 2] = rawPixels[srcIndex + 2]
            rgba[dstIndex + 3] = components >= 4 ? rawPixels[srcIndex + 3] : 255
          }
        }
      }

      const mimeType = 'image/jpeg'
      const quality = Math.max(0.1, Math.min(1, Number(asset.jpegQuality || 90) / 100))
      const photoshop = require('photoshop')
      const { imaging } = photoshop

      let encodedDataUrl = ''
      let imageData = null

      try {
        const rgbBuffer = this.flattenRgbaForJpeg(rgba)

        imageData = await imaging.createImageDataFromBuffer(rgbBuffer, {
          width: canvasWidth,
          height: canvasHeight,
          components: 3,
          chunky: true,
          colorSpace: 'RGB',
          colorProfile: 'sRGB IEC61966-2.1',
        })

        const jpegBase64 = await imaging.encodeImageData({
          imageData,
          base64: true,
        })
        encodedDataUrl = `data:${mimeType};base64,${jpegBase64}`
      } finally {
        try {
          imageData?.dispose?.()
        } catch {}
      }

      if (!encodedDataUrl) {
        return ''
      }

      if (outputWidth === canvasWidth && outputHeight === canvasHeight) {
        return encodedDataUrl
      }

      return this.resizeDataUrl(encodedDataUrl, outputWidth, outputHeight, mimeType, quality)
    }

    flattenRgbaForJpeg(rgba) {
      const source = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba || 0)
      const pixelCount = Math.floor(source.length / 4)
      const rgb = new Uint8Array(pixelCount * 3)

      for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
        const srcIndex = pixelIndex * 4
        const dstIndex = pixelIndex * 3
        const alpha = source[srcIndex + 3] / 255
        const matte = 255

        rgb[dstIndex] = Math.round(source[srcIndex] * alpha + matte * (1 - alpha))
        rgb[dstIndex + 1] = Math.round(source[srcIndex + 1] * alpha + matte * (1 - alpha))
        rgb[dstIndex + 2] = Math.round(source[srcIndex + 2] * alpha + matte * (1 - alpha))
      }

      return rgb
    }

    resizeDataUrl(dataUrl, width, height, mimeType = 'image/jpeg', quality = 0.9) {
      if (!dataUrl || typeof document === 'undefined') {
        return dataUrl
      }

      return new Promise((resolve) => {
        try {
          const image = document.createElement('img')
          image.onload = () => {
            try {
              const canvas = document.createElement('canvas')
              canvas.width = Math.max(1, Math.round(width || image.naturalWidth || image.width || 1))
              canvas.height = Math.max(1, Math.round(height || image.naturalHeight || image.height || 1))
              const ctx = canvas.getContext('2d')
              if (!ctx) {
                resolve(dataUrl)
                return
              }

              ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
              resolve(canvas.toDataURL(mimeType, quality))
            } catch {
              resolve(dataUrl)
            }
          }
          image.onerror = () => resolve(dataUrl)
          image.src = dataUrl
        } catch {
          resolve(dataUrl)
        }
      })
    }

    resolveDataUrlExtension(dataUrl = '', fallbackFormat = 'png') {
      const normalized = String(dataUrl || '')
      const matchedMime = normalized.match(/^data:(image\/[a-z0-9.+-]+);base64,/i)
      const mimeType = (matchedMime?.[1] || '').toLowerCase()

      if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg'
      if (mimeType.includes('webp')) return 'webp'
      if (mimeType.includes('gif')) return 'gif'
      if (mimeType.includes('bmp')) return 'bmp'
      if (mimeType.includes('png')) return 'png'

      const normalizedFallback = String(fallbackFormat || '').toLowerCase()
      if (normalizedFallback === 'jpeg') return 'jpg'
      return normalizedFallback || 'png'
    }

    dataUrlToArrayBuffer(dataUrl) {
      const base64 = String(dataUrl || '').replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)

      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
      }

      return bytes.buffer
    }

    extractImageDimensionsFromDataUrl(dataUrl) {
      try {
        const bytes = new Uint8Array(this.dataUrlToArrayBuffer(dataUrl))
        const mimeType = String(dataUrl || '').match(/^data:([^;]+);base64,/i)?.[1] || ''

        if (mimeType === 'image/png' && bytes.length >= 24) {
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          const width = view.getUint32(16)
          const height = view.getUint32(20)
          if (width > 0 && height > 0) {
            return { width, height }
          }
        }

        if (mimeType === 'image/jpeg') {
          let offset = 2
          while (offset + 9 < bytes.length) {
            if (bytes[offset] !== 0xff) {
              offset += 1
              continue
            }

            const marker = bytes[offset + 1]
            if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3) {
              const height = (bytes[offset + 5] << 8) + bytes[offset + 6]
              const width = (bytes[offset + 7] << 8) + bytes[offset + 8]
              if (width > 0 && height > 0) {
                return { width, height }
              }
              break
            }

            const segmentLength = (bytes[offset + 2] << 8) + bytes[offset + 3]
            if (!segmentLength || segmentLength < 2) break
            offset += 2 + segmentLength
          }
        }
      } catch {
        // ignore parse failures
      }

      return { width: 0, height: 0 }
    }

    async fetchImageAsDataUrl(url) {
      if (String(url || '').startsWith('data:')) {
        return String(url)
      }

      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`下载生成图片失败 (${response.status})`)
      }

      const blob = await response.blob()
      return this.blobToDataUrl(blob)
    }

    blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('生成图片读取失败'))
        reader.readAsDataURL(blob)
      })
    }
  }

  global.TunanApiEngine = TunanApiEngine
})(window)

