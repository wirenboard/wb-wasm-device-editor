pipeline {
    agent {
        label 'devenv'
    }

    options {
        disableConcurrentBuilds()
    }

    environment {
        SKIP_AUTO_RELEASE_BUILD = 'false'
    }

    stages {
        stage('Detect auto-release commit') {
            steps {
                script {
                    def commitMessage = sh(
                        returnStdout: true,
                        script: 'git log -1 --pretty=%B'
                    ).trim()

                    echo "Branch: ${env.BRANCH_NAME}"
                    echo "Last commit message:\n${commitMessage}"

                    def isAutoReleaseCommit =
                        env.BRANCH_NAME == 'master' && (
                            (commitMessage =~ /\[skip-wasm-publish\]/) ||
                            (commitMessage =~ /chore\((master|main)\): release\b/) ||
                            (commitMessage =~ /release-please/)
                        )

                    env.SKIP_AUTO_RELEASE_BUILD = isAutoReleaseCommit ? 'true' : 'false'

                    if (isAutoReleaseCommit) {
                        currentBuild.description = 'Auto-release commit detected: heavy stages skipped'
                        echo 'Auto-release commit detected. Heavy stages will be skipped.'
                    } else {
                        echo 'Regular commit detected. Full pipeline will run.'
                    }
                }
            }
        }

        stage('Build WASM module') {
            when {
                beforeAgent true
                expression { env.SKIP_AUTO_RELEASE_BUILD != 'true' }
            }
            agent {
                docker {
                    image 'registry.wirenboard.com/wirenboard/emsdk:latest'
                    args '--entrypoint="" -u root:root'
                    reuseNode true
                }
            }
            steps {
                sh 'bash -c "source /emsdk/emsdk_env.sh; emmake make -f wasm.mk"'
            }
        }

        stage('Build configurator') {
            when {
                beforeAgent true
                expression { env.SKIP_AUTO_RELEASE_BUILD != 'true' }
            }
            agent {
                docker {
                    image 'node:latest'
                    args '--entrypoint="" -u root:root'
                    reuseNode true
                }
            }
            steps {
                dir(path: 'submodule/homeui/frontend') {
                    sh 'npm install --no-package-lock'
                }
                dir(path: 'wasm') {
                    sh 'npm install --no-package-lock'
                    sh 'npm run build'
                }
                // Read once; later stages (Upload to CDN, Build Docker) reuse env.WASM_VERSION.
                script {
                    env.WASM_VERSION = sh(
                        returnStdout: true,
                        script: "node -p \"require('./wasm/package.json').version\"",
                    ).trim()
                }
            }
        }

        stage('Build offline single-file') {
            when {
                beforeAgent true
                expression { env.SKIP_AUTO_RELEASE_BUILD != 'true' }
            }
            agent {
                docker {
                    image 'node:latest'
                    args '--entrypoint="" -u root:root'
                    reuseNode true
                }
            }
            steps {
                dir(path: 'wasm') {
                    sh 'npm run build:offline'
                    // Merge the standalone HTML into dist-configurator so it
                    // ships in the tarball, Docker image, and S3 sync all from
                    // a single dist-configurator/ tree.
                    sh 'mkdir -p dist-configurator/offline'
                    sh 'cp dist-offline/index.html dist-configurator/offline/index.html'
                    sh 'tar czf dist-configurator.tar.gz dist-configurator'
                }
            }
            post {
                success {
                    archiveArtifacts(
                        artifacts: 'wasm/dist-configurator.tar.gz, wasm/dist-offline/index.html',
                        fingerprint: true
                    )
                }
            }
        }

        stage('E2E tests') {
            when {
                beforeAgent true
                expression { env.SKIP_AUTO_RELEASE_BUILD != 'true' }
            }
            agent {
                docker {
                    image 'registry.wirenboard.com/wirenboard/node-playwright:node22-pw1.59.1-chromium'
                    args '--entrypoint="" -u root:root'
                    reuseNode true
                }
            }
            steps {
                dir(path: 'wasm') {
                    sh '''
                        export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
                        npm run test:e2e
                    '''
                }
            }
        }

        stage('Upload to CDN') {
            when {
                beforeAgent true
                expression {
                    wb.isBranchRelease(env.BRANCH_NAME) && env.SKIP_AUTO_RELEASE_BUILD != 'true'
                }
            }
            steps {
                withCredentials([file(credentialsId: 's3cmd-deveditor-config', variable: 'S3CMD_CONFIG')]) {
                    sh 'wbdev user s3cmd -c $S3CMD_CONFIG sync --delete-removed --guess-mime-type --no-mime-magic wasm/dist-configurator/ s3://wb-deveditor-02/'
                    // Offline single-file: URL stays at /offline/index.html, but
                    // Content-Disposition makes the browser save it with the
                    // versioned filename when the user downloads it.
                    sh '''
                        wbdev user s3cmd -c $S3CMD_CONFIG put \
                            --mime-type=text/html \
                            --add-header="Content-Disposition: attachment; filename=\\"wb-device-editor-${WASM_VERSION}.html\\"" \
                            wasm/dist-offline/index.html \
                            s3://wb-deveditor-02/offline/index.html
                    '''
                }
            }
        }

        stage('Build and publish Docker image') {
            when {
                beforeAgent true
                expression {
                    wb.isBranchRelease(env.BRANCH_NAME) && env.SKIP_AUTO_RELEASE_BUILD != 'true'
                }
            }
            environment {
                IMAGE_TAG = "contactless/wasm-device-editor:latest"
                DOCKERHUB_CREDS = credentials('dockerhub-login')
            }
            steps {
                sh '''
                docker build --no-cache --build-arg "VERSION=${WASM_VERSION}" --tag "$IMAGE_TAG" wasm
                echo "$DOCKERHUB_CREDS_PSW" | docker login --username "$DOCKERHUB_CREDS_USR" --password-stdin
                docker push "$IMAGE_TAG"
                docker logout
                '''
            }
        }
    }

    post {
        always {
            script {
                if (wb.isBranchRelease(env.BRANCH_NAME) && env.SKIP_AUTO_RELEASE_BUILD != 'true') {
                    wb.notifyMaybeBuildRestored()
                } else {
                    echo 'Skip notifications for auto-release build.'
                }
            }
        }
        failure {
            script {
                if (wb.isBranchRelease(env.BRANCH_NAME) && env.SKIP_AUTO_RELEASE_BUILD != 'true') {
                    wb.notifyBuildFailed()
                } else {
                    echo 'Skip failure notification for auto-release build.'
                }
            }
        }
    }
}
