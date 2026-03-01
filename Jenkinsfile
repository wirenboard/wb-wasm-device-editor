pipeline {
    agent {
        label 'devenv'
    }
    stages {
        stage('Build WASM module') {
            agent {
                docker {
                    image 'registry.wirenboard.lan/emsdk:latest'
                    args '--entrypoint="" -u root:root'
                    reuseNode true
                }
            }
            steps {
                sh 'bash -c "source /emsdk/emsdk_env.sh; emmake make -f wasm.mk"'
            }
        }
        stage('Build configurator') {
            agent {
                docker {
                    image 'node:latest'
                    args '--entrypoint="" -u root:root'
                    reuseNode true
                }
            }
            steps {
                dir(path: 'submodule/homeui/frontend') {
                    sh 'npm install'
                }
                dir(path: 'wasm') {
                    sh 'npm install'
                    sh 'npm run build'
                    sh 'tar czf dist-configurator.tar.gz dist-configurator'
                }
            }
            post {
                success {
                    archiveArtifacts artifacts: 'wasm/dist-configurator.tar.gz', fingerprint: true
                }
            }
        }
        stage('E2E tests') {
            agent {
                docker {
                    image 'node:latest'
                    args '--entrypoint="" -u root:root'
                    reuseNode true
                }
            }
            steps {
                dir(path: 'wasm') {
                    sh 'npx playwright install --with-deps chromium'
                    sh 'npm run test:e2e'
                }
            }
        }
        stage('Upload to CDN') {
            when { expression {
                wb.isBranchRelease(env.BRANCH_NAME)
            }}
            steps {
                dir(path: 'wasm/dist-configurator') {
                    withCredentials([file(credentialsId: 's3cmd-deveditor-config', variable: 'S3CMD_CONFIG')]) {
                        sh 'wbdev user s3cmd -c $S3CMD_CONFIG sync --delete-removed ./ s3://wb-deveditor-02/'
                    }
                }
            }
        }
        stage('Build and publish Docker image') {
            when { expression {
                wb.isBranchRelease(env.BRANCH_NAME)
            }}
            environment {
                IMAGE_TAG = "contactless/wasm-device-editor:latest"
                DOCKERHUB_CREDS = credentials('dockerhub-login')
            }
            steps {
                sh """
                docker build --no-cache --tag "$IMAGE_TAG" wasm
                echo "$DOCKERHUB_CREDS_PSW" | docker login --username "$DOCKERHUB_CREDS_USR" --password-stdin
                docker push "$IMAGE_TAG"
                docker logout
                """
            }
        }
    }
    post {
        always { script {
            if (wb.isBranchRelease(env.BRANCH_NAME)) {
                wb.notifyMaybeBuildRestored()
            }
        }}
        failure { script {
            if (wb.isBranchRelease(env.BRANCH_NAME)) {
                wb.notifyBuildFailed()
            }
        }}
    }
}
